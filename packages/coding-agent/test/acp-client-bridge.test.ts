import { describe, expect, it } from "bun:test";
import { createAcpClientBridge } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-client-bridge";
import {
	RequestError,
	type AgentSideConnection,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
} from "@oh-my-pi/pi-utils/acp";

const ALLOW_SELECTED: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow_once" } };

const TOOL_CALL = {
	toolCallId: "call-1",
	toolName: "bash",
	title: "echo hi",
	kind: "execute" as const,
	status: "pending" as const,
	rawInput: { command: "echo hi" },
	content: [{ type: "content" as const, content: { type: "text" as const, text: "$ echo hi" } }],
};

const OPTIONS = [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" as const }];

describe("ACP client bridge permission requests", () => {
	it("forwards pending tool-call status to session/request_permission", async () => {
		let request: RequestPermissionRequest | undefined;
		const connection = {
			requestPermissionWithCancel(params: RequestPermissionRequest) {
				request = params;
				return { promise: Promise.resolve(ALLOW_SELECTED), cancel: () => {} };
			},
		} as unknown as AgentSideConnection;

		const bridge = createAcpClientBridge(connection, "session-1", {});

		await bridge.requestPermission!({ ...TOOL_CALL }, OPTIONS);

		expect(request?.toolCall).toMatchObject({
			toolCallId: "call-1",
			title: "echo hi",
			kind: "execute",
			status: "pending",
			rawInput: { command: "echo hi" },
			content: [{ type: "content", content: { type: "text", text: "$ echo hi" } }],
		});
	});

	it("cancels the pending wire permission request when a steer supersedes the dialog", async () => {
		let request: RequestPermissionRequest | undefined;
		let cancelled = 0;
		const answer: { promise: Promise<RequestPermissionResponse> | undefined } = { promise: undefined };
		const held = Promise.withResolvers<RequestPermissionResponse>();
		const connection = {
			requestPermissionWithCancel(params: RequestPermissionRequest) {
				request = params;
				return {
					// Undefined means "leave the elicit pending" (dialog open).
					promise: answer.promise ?? held.promise,
					cancel() {
						cancelled++;
						// Mirrors RpcConnection.requestCancellable: cancel
						// rejects the pending wire promise.
						held.reject(RequestError.requestCancelled());
					},
				};
			},
		} as unknown as AgentSideConnection;

		const bridge = createAcpClientBridge(connection, "session-1", {});
		const steeringSignal = new AbortController();

		const pending = bridge.requestPermission!({ ...TOOL_CALL }, OPTIONS, undefined, steeringSignal.signal);
		steeringSignal.abort();
		// The wire request is cancelled (no live `session/request_permission`
		// left on the client) and the gate sees a cancelled outcome.
		await expect(pending).resolves.toEqual({ outcome: "cancelled" });
		expect(cancelled).toBe(1);

		// A steer that already arrived before the elicit opens cancels immediately.
		cancelled = 0;
		const alreadySteered = bridge.requestPermission!({ ...TOOL_CALL }, OPTIONS, undefined, steeringSignal.signal);
		await expect(alreadySteered).resolves.toEqual({ outcome: "cancelled" });
		expect(cancelled).toBe(1);
		expect(request?.toolCall.toolCallId).toBe("call-1");

		// No steering signal: the plain elicit path answers normally.
		answer.promise = Promise.resolve(ALLOW_SELECTED);
		const plain = bridge.requestPermission!({ ...TOOL_CALL }, OPTIONS);
		await expect(plain).resolves.toEqual({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	});
});
