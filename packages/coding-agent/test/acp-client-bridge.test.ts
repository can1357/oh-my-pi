import { describe, expect, it } from "bun:test";
import type { AgentSideConnection, ClientCapabilities, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { createAcpClientBridge } from "@pk-nerdsaver-ai/pi-coding-agent/modes/acp/acp-client-bridge";

describe("ACP client bridge permission requests", () => {
	it("forwards pending tool-call status to session/request_permission", async () => {
		let request: RequestPermissionRequest | undefined;
		const connection = {
			async requestPermission(params: RequestPermissionRequest) {
				request = params;
				return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
			},
		} as unknown as AgentSideConnection;

		const bridge = createAcpClientBridge(connection, "session-1", {});

		await bridge.requestPermission!(
			{
				toolCallId: "call-1",
				toolName: "bash",
				title: "echo hi",
				kind: "execute",
				status: "pending",
				rawInput: { command: "echo hi" },
				content: [{ type: "content", content: { type: "text", text: "$ echo hi" } }],
			},
			[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		);

		expect(request?.toolCall).toMatchObject({
			toolCallId: "call-1",
			title: "echo hi",
			kind: "execute",
			status: "pending",
			rawInput: { command: "echo hi" },
			content: [{ type: "content", content: { type: "text", text: "$ echo hi" } }],
		});
	});

	it("activates strict write/exec approval only for the exact Pkzz owner-permission bridge v1 marker", () => {
		const connection = {} as AgentSideConnection;
		const bridge = createAcpClientBridge(connection, "session-1", {
			_meta: {
				pkzz: {
					ownerPermissionBridge: { version: 1 },
				},
			},
		});

		expect(bridge.capabilities.toolApprovalMode).toBe("always-ask");
	});

	it("preserves legacy approval behavior for absent, malformed, false, or unknown bridge versions", () => {
		const connection = {} as AgentSideConnection;
		const unmarkedCapabilities: unknown[] = [
			undefined,
			{},
			{ _meta: null },
			{ _meta: { pkzz: false } },
			{ _meta: { pkzz: { ownerPermissionBridge: false } } },
			{ _meta: { pkzz: { ownerPermissionBridge: { version: false } } } },
			{ _meta: { pkzz: { ownerPermissionBridge: { version: "1" } } } },
			{ _meta: { pkzz: { ownerPermissionBridge: { version: 0 } } } },
			{ _meta: { pkzz: { ownerPermissionBridge: { version: 2 } } } },
			{ _meta: { pkzz: { ownerPermissionBridge: [{ version: 1 }] } } },
		];

		for (const capabilities of unmarkedCapabilities) {
			const bridge = createAcpClientBridge(connection, "session-1", capabilities as ClientCapabilities | undefined);
			expect(bridge.capabilities.toolApprovalMode).toBeUndefined();
		}
	});
});
