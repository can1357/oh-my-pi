import { describe, expect, test, vi } from "bun:test";
import {
	buildRpcToolApprovalRequest,
	isRpcToolApprovalRequest,
	RpcToolApprovalBridge,
	RPC_TOOL_APPROVAL_MAX_STRING_BYTES,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/tool-approval";
import type {
	RpcToolApprovalCancelRequest,
	RpcToolApprovalRequest,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { ToolApprovalRequest } from "@oh-my-pi/pi-coding-agent/tools/approval";

const shellApproval: ToolApprovalRequest = {
	toolCallId: "toolu_shell_1",
	toolName: "bash",
	toolKind: "shell",
	tier: "exec",
	input: { command: "rm -rf build", cwd: "/workspace", env: { API_TOKEN: "secret", PATH: "/bin" } },
	reason: "Critical pattern detected",
	details: ["Command: rm -rf build"],
};

function requireRequest(
	frame: RpcToolApprovalRequest | RpcToolApprovalCancelRequest | undefined,
): RpcToolApprovalRequest {
	if (frame?.type !== "tool_approval_request") throw new Error("Expected a tool approval request");
	return frame;
}

describe("RPC tool approvals", () => {
	test("emits a bounded structured shell request and redacts environment values", () => {
		const request = buildRpcToolApprovalRequest("approval-1", {
			...shellApproval,
			input: {
				command: "x".repeat(RPC_TOOL_APPROVAL_MAX_STRING_BYTES * 2),
				cwd: "/workspace",
				env: { API_TOKEN: "secret", PATH: "/bin" },
				password: "do-not-emit",
				oauthToken: "also-do-not-emit",
			},
			details: ["Command: dangerous", "d".repeat(10_000)],
		});

		expect(isRpcToolApprovalRequest(request)).toBe(true);
		expect(request).toMatchObject({
			type: "tool_approval_request",
			id: "approval-1",
			toolCallId: "toolu_shell_1",
			toolName: "bash",
			toolKind: "shell",
			detail: { reason: "Critical pattern detected", truncated: true, redacted: true },
		});
		expect(Buffer.byteLength(request.input.command as string, "utf8")).toBeLessThanOrEqual(
			RPC_TOOL_APPROVAL_MAX_STRING_BYTES,
		);
		expect(request.input.env).toEqual({ API_TOKEN: "[redacted]", PATH: "[redacted]" });
		expect(request.input.password).toBe("[redacted]");
		expect(request.input.oauthToken).toBe("[redacted]");
		expect(isRpcToolApprovalRequest({ ...request, displayApproved: true })).toBe(false);
		expect(isRpcToolApprovalRequest({ ...request, detail: { ...request.detail, approved: true } })).toBe(false);
	});

	test("preserves bounded edit and write fields for native rendering", () => {
		const edit = buildRpcToolApprovalRequest("approval-edit", {
			toolCallId: "toolu_edit_1",
			toolName: "edit",
			toolKind: "edit",
			tier: "write",
			input: { path: "src/app.ts", old_string: "before", new_string: "after" },
			details: ["File: src/app.ts"],
		});
		const write = buildRpcToolApprovalRequest("approval-write", {
			toolCallId: "toolu_write_1",
			toolName: "write",
			toolKind: "write",
			tier: "write",
			input: { path: "src/new.ts", content: "export const ready = true;\n" },
			details: ["Path: src/new.ts", "Content:\nexport const ready = true;"],
		});

		expect(edit.input).toEqual({ path: "src/app.ts", old_string: "before", new_string: "after" });
		expect(edit.detail.lines).toEqual(["File: src/app.ts"]);
		expect(write.input).toEqual({ path: "src/new.ts", content: "export const ready = true;\n" });
		expect(write.detail.lines).toEqual(["Path: src/new.ts", "Content:\nexport const ready = true;"]);
	});

	test("binds a response to both immutable ids and consumes it exactly once", async () => {
		const frames: Array<RpcToolApprovalRequest | RpcToolApprovalCancelRequest> = [];
		const bridge = new RpcToolApprovalBridge(frame => frames.push(frame));
		const result = bridge.request(shellApproval);
		const request = requireRequest(frames[0]);
		const response = {
			type: "tool_approval_response" as const,
			id: request.id,
			toolCallId: request.toolCallId,
			approved: true,
		};

		expect(bridge.handleResponse(response)).toBe(true);
		expect(await result).toBe(true);
		expect(bridge.handleResponse({ ...response, approved: false })).toBe(true);
	});

	test("ignores an unknown forged id without disturbing the pending approval", async () => {
		const frames: Array<RpcToolApprovalRequest | RpcToolApprovalCancelRequest> = [];
		const bridge = new RpcToolApprovalBridge(frame => frames.push(frame));
		const result = bridge.request(shellApproval);
		const request = requireRequest(frames[0]);

		expect(
			bridge.handleResponse({
				type: "tool_approval_response",
				id: "forged-id",
				toolCallId: request.toolCallId,
				approved: true,
			}),
		).toBe(true);
		bridge.handleResponse({
			type: "tool_approval_response",
			id: request.id,
			toolCallId: request.toolCallId,
			approved: false,
		});
		expect(await result).toBe(false);
	});

	test("fails closed on a mismatched tool call id or malformed matching response", async () => {
		for (const response of [
			{ toolCallId: "other-call", approved: true },
			{ toolCallId: shellApproval.toolCallId, approved: true, cancelled: true },
		]) {
			const frames: Array<RpcToolApprovalRequest | RpcToolApprovalCancelRequest> = [];
			const bridge = new RpcToolApprovalBridge(frame => frames.push(frame));
			const result = bridge.request(shellApproval);
			const request = requireRequest(frames[0]);
			bridge.handleResponse({ type: "tool_approval_response", id: request.id, ...response });
			await expect(result).rejects.toThrow(/Malformed|did not match/);
		}
	});

	test("cancels the host presentation and denies when the caller aborts", async () => {
		const frames: Array<RpcToolApprovalRequest | RpcToolApprovalCancelRequest> = [];
		const bridge = new RpcToolApprovalBridge(frame => frames.push(frame));
		const controller = new AbortController();
		const result = bridge.request(shellApproval, { signal: controller.signal });
		const request = requireRequest(frames[0]);

		controller.abort();

		expect(await result).toBe(false);
		expect(frames[1]).toEqual({
			type: "tool_approval_cancel",
			id: expect.any(String),
			targetId: request.id,
			toolCallId: request.toolCallId,
		});
	});

	test("treats a host timeout response as denial and reports the timeout", async () => {
		const frames: Array<RpcToolApprovalRequest | RpcToolApprovalCancelRequest> = [];
		const bridge = new RpcToolApprovalBridge(frame => frames.push(frame));
		const onTimeout = vi.fn();
		const result = bridge.request(shellApproval, { onTimeout });
		const request = requireRequest(frames[0]);

		bridge.handleResponse({
			type: "tool_approval_response",
			id: request.id,
			toolCallId: request.toolCallId,
			cancelled: true,
			timedOut: true,
		});

		expect(await result).toBe(false);
		expect(onTimeout).toHaveBeenCalledTimes(1);
	});

	test("times out locally, notifies the host, and ignores a late approval", async () => {
		const frames: Array<RpcToolApprovalRequest | RpcToolApprovalCancelRequest> = [];
		const bridge = new RpcToolApprovalBridge(frame => frames.push(frame));
		const onTimeout = vi.fn();
		const result = bridge.request(shellApproval, { timeout: 1, onTimeout });
		const request = requireRequest(frames[0]);

		expect(await result).toBe(false);
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(frames[1]).toMatchObject({ type: "tool_approval_cancel", targetId: request.id });
		expect(
			bridge.handleResponse({
				type: "tool_approval_response",
				id: request.id,
				toolCallId: request.toolCallId,
				approved: true,
			}),
		).toBe(true);
	});
});
