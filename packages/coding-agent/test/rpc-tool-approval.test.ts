import { describe, expect, test, vi } from "bun:test";
import {
	buildRpcToolApprovalRequest,
	isRpcToolApprovalRequest,
	RpcToolApprovalBridge,
	RPC_TOOL_APPROVAL_MAX_FRAME_BYTES,
	RPC_TOOL_APPROVAL_MAX_STRING_BYTES,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/tool-approval";
import type {
	RpcToolApprovalCancelRequest,
	RpcToolApprovalRequest,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { buildToolApprovalIdentity } from "@oh-my-pi/pi-coding-agent/tools/approval";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ToolApprovalRequest } from "@oh-my-pi/pi-coding-agent/tools/approval";

const shellApproval: ToolApprovalRequest = {
	toolCallId: "toolu_shell_1",
	toolName: "bash",
	toolKind: "shell",
	identity: { kind: "shell", command: "rm -rf build" },
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
			identity: { kind: "shell", command: "x".repeat(RPC_TOOL_APPROVAL_MAX_STRING_BYTES * 2) },
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
		expect(request.identity).toMatchObject({ kind: "shell", command: expect.any(String) });
		expect(Buffer.byteLength(request.input.command as string, "utf8")).toBeLessThanOrEqual(
			RPC_TOOL_APPROVAL_MAX_STRING_BYTES,
		);
		expect(request.input.env).toEqual({ API_TOKEN: "[redacted]", PATH: "[redacted]" });
		expect(request.input.password).toBe("[redacted]");
		expect(request.input.oauthToken).toBe("[redacted]");
		expect(isRpcToolApprovalRequest({ ...request, identity: { ...request.identity, approved: true } })).toBe(false);
		expect(isRpcToolApprovalRequest({ ...request, displayApproved: true })).toBe(false);
		expect(isRpcToolApprovalRequest({ ...request, detail: { ...request.detail, approved: true } })).toBe(false);
	});

	test("truncates over-depth input before validation", () => {
		const request = buildRpcToolApprovalRequest("deep-input", {
			...shellApproval,
			input: { command: "echo deep", nested: { a: { b: { c: { d: { e: "too deep" } } } } } },
			identity: { kind: "shell", command: "echo deep" },
		});

		expect(isRpcToolApprovalRequest(request)).toBe(true);
		expect(request.input).toEqual({
			command: "echo deep",
			nested: { a: { b: { c: "[truncated]" } } },
		});
		expect(request.detail.truncatedFields).toContain("input.nested");
	});

	test("depth-guards nested env before applying its redaction special case", () => {
		const request = buildRpcToolApprovalRequest("deep-env", {
			...shellApproval,
			input: {
				nested: { a: { b: { env: { PATH: "/bin" } } } },
				inDepth: { env: { PATH: "/usr/bin" } },
			},
		});

		expect(isRpcToolApprovalRequest(request)).toBe(true);
		expect(request.input).toEqual({
			nested: { a: { b: { env: "[truncated]" } } },
			inDepth: { env: { PATH: "[redacted]" } },
		});
		expect(request.detail.truncatedFields).toContain("input.nested");
		expect(request.detail.redactedFields).toContain("input.inDepth");
	});

	test("derives long apply-patch and hashline paths from structured edit inspection", () => {
		const session: ToolSession = {
			cwd: ".",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const longPath = `src/${"nested/".repeat(700)}target.ts`;
		const cases = [
			{
				tool: new EditTool(session, "apply_patch"),
				input: `*** Begin Patch\n*** Update File: ${longPath}\n@@\n-old\n+new\n*** End Patch\n`,
			},
			{
				tool: new EditTool(session, "hashline"),
				input: `[${longPath}#A1B2]\nPUT 1.=1:\n+new`,
			},
		] as const;

		for (const [index, { tool, input }] of cases.entries()) {
			const identity = buildToolApprovalIdentity(tool, "edit", { input });
			expect(identity).toEqual({ kind: "edit", paths: [longPath], content: input });
			const request = buildRpcToolApprovalRequest(`long-edit-${index}`, {
				toolCallId: `toolu_long_edit_${index}`,
				toolName: "edit",
				toolKind: "edit",
				tier: "write",
				identity,
				input: { input },
				details: [`File: ${longPath.slice(0, 2_000)}`],
			});
			if (request.identity.kind !== "edit") throw new Error("Expected edit identity");
			expect(request.identity.paths[0]).not.toBe(longPath.slice(0, 2_000));
			expect(request.detail.truncatedFields).toContain("identity.paths");
			expect(isRpcToolApprovalRequest(request)).toBe(true);
		}
	});

	test("preserves bounded edit and write fields for native rendering", () => {
		const edit = buildRpcToolApprovalRequest("approval-edit", {
			toolCallId: "toolu_edit_1",
			toolName: "edit",
			toolKind: "edit",
			identity: { kind: "edit", paths: ["src/app.ts"], content: "after" },
			tier: "write",
			input: { path: "src/app.ts", old_string: "before", new_string: "after" },
			details: ["File: src/app.ts"],
		});
		const write = buildRpcToolApprovalRequest("approval-write", {
			toolCallId: "toolu_write_1",
			toolName: "write",
			toolKind: "write",
			tier: "write",
			identity: { kind: "write", path: "src/new.ts", content: "export const ready = true;\n" },
			input: { path: "src/new.ts", content: "export const ready = true;\n" },
			details: ["Path: src/new.ts", "Content:\nexport const ready = true;"],
		});

		expect(edit.input).toEqual({ path: "src/app.ts", old_string: "before", new_string: "after" });
		expect(edit.detail.lines).toEqual(["File: src/app.ts"]);
		expect(edit.identity).toEqual({ kind: "edit", paths: ["src/app.ts"], content: "after" });
		expect(write.input).toEqual({ path: "src/new.ts", content: "export const ready = true;\n" });
		expect(write.detail.lines).toEqual(["Path: src/new.ts", "Content:\nexport const ready = true;"]);
		expect(write.identity).toEqual({ kind: "write", path: "src/new.ts", content: "export const ready = true;\n" });
	});

	test("reports required write identity truncation per field", () => {
		const escaped = `\\"😀`.repeat(8_000);
		const write = buildRpcToolApprovalRequest("truncated-write", {
			toolCallId: "toolu_write_truncated",
			toolName: "write",
			toolKind: "write",
			tier: "write",
			input: { path: `src/${escaped}`, content: escaped },
			identity: { kind: "write", path: `src/${escaped}`, content: escaped },
			details: [],
		});

		expect(write.identity.kind).toBe("write");
		if (write.identity.kind !== "write") throw new Error("Expected write identity");
		expect(write.identity.path.length).toBeGreaterThan(0);
		expect(write.identity.content.length).toBeGreaterThan(0);
		expect(write.detail.truncatedFields).toEqual(expect.arrayContaining(["identity.path", "identity.content"]));
		expect(Buffer.byteLength(JSON.stringify(write), "utf8") + 1).toBeLessThanOrEqual(
			RPC_TOOL_APPROVAL_MAX_FRAME_BYTES,
		);
	});

	test("reserves shell identity before adversarial generic args and aggregate escaped detail", () => {
		const escaped = `\\"😀`.repeat(4_000);
		const input = Object.fromEntries([
			...Array.from({ length: 31 }, (_, index) => [`noise_${index}`, escaped]),
			["command", escaped],
		]);
		const approval: ToolApprovalRequest = {
			...shellApproval,
			identity: { kind: "shell", command: escaped },
			input,
			reason: escaped,
			details: Array.from({ length: 16 }, () => escaped),
			providerSafetyChecks: Array.from({ length: 16 }, () => escaped),
		};

		const first = buildRpcToolApprovalRequest("aggregate-1", approval);
		const second = buildRpcToolApprovalRequest("aggregate-1", approval);

		expect(first).toEqual(second);
		expect(Buffer.byteLength(JSON.stringify(first), "utf8") + 1).toBeLessThanOrEqual(
			RPC_TOOL_APPROVAL_MAX_FRAME_BYTES,
		);
		expect(first.identity.kind).toBe("shell");
		if (first.identity.kind !== "shell") throw new Error("Expected shell identity");
		expect(first.identity.command.length).toBeGreaterThan(0);
		expect(first.detail.truncated).toBe(true);
		expect(first.detail.truncatedFields).toContain("identity.command");
		expect(first.detail.lines.length).toBeLessThan(16);
		expect(isRpcToolApprovalRequest(first)).toBe(true);
	});

	test("keeps edit and write identity when required fields follow overflowing generic args", () => {
		const noiseValue = `\\"`.repeat(8_000);
		const noise = Array.from({ length: 32 }, (_, index) => [`noise_${index}`, noiseValue]);
		const edit = buildRpcToolApprovalRequest("ordered-edit", {
			toolCallId: "toolu_edit_ordered",
			toolName: "edit",
			toolKind: "edit",
			tier: "write",
			identity: { kind: "edit", paths: ["src/a.ts", "src/b.ts"], content: "+changed" },
			input: Object.fromEntries([...noise, ["paths", ["src/a.ts", "src/b.ts"]], ["input", "+changed"]]),
			details: [],
		});
		const write = buildRpcToolApprovalRequest("ordered-write", {
			toolCallId: "toolu_write_ordered",
			toolName: "write",
			toolKind: "write",
			tier: "write",
			identity: { kind: "write", path: "src/out.ts", content: "export const x = 1;" },
			input: Object.fromEntries([...noise, ["path", "src/out.ts"], ["content", "export const x = 1;"]]),
			details: [],
		});

		expect(edit.identity).toEqual({ kind: "edit", paths: ["src/a.ts", "src/b.ts"], content: "+changed" });
		expect(write.identity).toEqual({ kind: "write", path: "src/out.ts", content: "export const x = 1;" });
		for (const frame of [edit, write]) {
			expect(Buffer.byteLength(JSON.stringify(frame), "utf8") + 1).toBeLessThanOrEqual(
				RPC_TOOL_APPROVAL_MAX_FRAME_BYTES,
			);
			expect(frame.detail.truncated).toBe(true);
		}
	});

	test("fails closed when required tool identity is absent", () => {
		expect(() =>
			buildRpcToolApprovalRequest("missing-shell", {
				...shellApproval,
				identity: { kind: "shell", command: "" },
				input: { cwd: "/workspace" },
			}),
		).toThrow("required command identity");
		expect(() =>
			buildRpcToolApprovalRequest("missing-edit", {
				...shellApproval,
				toolKind: "edit",
				toolName: "edit",
				identity: { kind: "edit", paths: [], content: "" },
				input: { paths: ["src/a.ts"] },
			}),
		).toThrow("required paths and content identity");
		expect(() =>
			buildRpcToolApprovalRequest("missing-write", {
				...shellApproval,
				toolKind: "write",
				toolName: "write",
				identity: { kind: "write", path: "", content: "" },
				input: { path: "src/a.ts" },
			}),
		).toThrow("required path and content identity");
	});

	test("redacts infix credential keys and value-shaped secrets in every display field", () => {
		const token = `ghp_${"a".repeat(36)}`;
		const request = buildRpcToolApprovalRequest("redacted-1", {
			...shellApproval,
			input: {
				command: `deploy ${token}`,
				token_url: token,
				secretName: token,
				api_key_id: token,
				passwordConfirm: token,
				authorization_header_value: token,
			},
			reason: `token_url=${token}`,
			identity: { kind: "shell", command: `deploy ${token}` },
			details: [`Command token: ${token}`],
			providerSafetyChecks: [`authorization=${token}`],
		});
		const serialized = JSON.stringify(request);

		expect(serialized).not.toContain(token);
		expect(request.detail.redacted).toBe(true);
		expect(request.detail.redactedFields).toEqual(
			expect.arrayContaining([
				"identity.command",
				"input.token_url",
				"input.secretName",
				"input.api_key_id",
				"input.passwordConfirm",
				"input.authorization_header_value",
				"detail.reason",
				"detail.lines",
				"detail.providerSafetyChecks",
			]),
		);
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

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
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
