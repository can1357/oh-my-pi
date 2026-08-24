import { describe, expect, it } from "bun:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { checkAcpUpdateInvariants } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-update-invariants";

function toolCallUpdate(fields: Partial<SessionNotification["update"]>): SessionNotification {
	return {
		sessionId: "session-1",
		update: {
			sessionUpdate: "tool_call_update",
			toolCallId: "call-1",
			...fields,
		} as SessionNotification["update"],
	};
}

describe("checkAcpUpdateInvariants", () => {
	it("flags a terminal item sent alongside sibling content (invariant 1)", () => {
		const notification = toolCallUpdate({
			content: [
				{ type: "terminal", terminalId: "term-1" },
				{ type: "content", content: { type: "text", text: "exit code 0" } },
			],
		});

		const violations = checkAcpUpdateInvariants(notification, { terminalMetaCapable: true });

		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("call-1");
		expect(violations[0]).toContain("terminal item(s) [term-1]");
	});

	it("exempts the sibling-content fallback for a client that hasn't negotiated terminal_output", () => {
		// `acp-event-mapper.ts` keeps a
		// best-effort `[terminal, content]` sibling append for a real-terminal
		// client that never negotiated Zed's `_meta.terminal_output` extension —
		// `has_terminals` (Zed's exclusivity renderer quirk) doesn't apply to
		// that client, so invariant 1 must not fire here.
		const notification = toolCallUpdate({
			content: [
				{ type: "terminal", terminalId: "term-1" },
				{ type: "content", content: { type: "text", text: "exit code 0" } },
			],
		});

		expect(checkAcpUpdateInvariants(notification, { terminalMetaCapable: false })).toEqual([]);
	});

	it("allows a terminal item with no siblings", () => {
		const notification = toolCallUpdate({ content: [{ type: "terminal", terminalId: "term-1" }] });

		expect(checkAcpUpdateInvariants(notification, { terminalMetaCapable: true })).toEqual([]);
	});

	it("allows non-terminal content of any length", () => {
		const notification = toolCallUpdate({
			content: [
				{ type: "content", content: { type: "text", text: "a" } },
				{ type: "content", content: { type: "text", text: "b" } },
			],
		});

		expect(checkAcpUpdateInvariants(notification, { terminalMetaCapable: true })).toEqual([]);
	});

	it("flags _meta.terminal_output when the client never negotiated the capability (invariant 2)", () => {
		const notification = toolCallUpdate({
			_meta: { terminal_output: { terminal_id: "call-1", data: "hi" } },
		});

		const violations = checkAcpUpdateInvariants(notification, { terminalMetaCapable: false });

		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("terminal_output");
	});

	it("allows _meta.terminal_* once the capability is negotiated", () => {
		const notification = toolCallUpdate({
			_meta: { terminal_exit: { terminal_id: "call-1", exit_code: 0, signal: null } },
		});

		expect(checkAcpUpdateInvariants(notification, { terminalMetaCapable: true })).toEqual([]);
	});

	it("ignores non-terminal _meta keys regardless of capability", () => {
		const notification = toolCallUpdate({ _meta: { some_other_extension: true } });

		expect(checkAcpUpdateInvariants(notification, { terminalMetaCapable: false })).toEqual([]);
	});

	it("flags a nonzero terminal exit reported with a completed status (invariant 3)", () => {
		// The card's status and its
		// terminal's exit line are two derivations of the same result; a user
		// reads them together, so a success check above "exit code 1" is a
		// self-contradicting frame.
		const notification = toolCallUpdate({
			status: "completed",
			content: [{ type: "terminal", terminalId: "call-1" }],
			_meta: { terminal_exit: { terminal_id: "call-1", exit_code: 1, signal: null } },
		});

		const violations = checkAcpUpdateInvariants(notification, { terminalMetaCapable: true });

		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("exit_code 1");
	});

	it("allows a failed status with a nonzero exit, and a completed status with exit 0", () => {
		const failed = toolCallUpdate({
			status: "failed",
			_meta: { terminal_exit: { terminal_id: "call-1", exit_code: 1, signal: null } },
		});
		const completed = toolCallUpdate({
			status: "completed",
			_meta: { terminal_exit: { terminal_id: "call-1", exit_code: 0, signal: null } },
		});

		expect(checkAcpUpdateInvariants(failed, { terminalMetaCapable: true })).toEqual([]);
		expect(checkAcpUpdateInvariants(completed, { terminalMetaCapable: true })).toEqual([]);
	});

	it("allows a failed status with no exit code at all (an aborted call)", () => {
		// A tool can fail for reasons no process exit status expresses, so the
		// reverse pairing is deliberately not checked.
		const notification = toolCallUpdate({
			status: "failed",
			_meta: { terminal_exit: { terminal_id: "call-1", signal: null } },
		});

		expect(checkAcpUpdateInvariants(notification, { terminalMetaCapable: true })).toEqual([]);
	});

	it("ignores session updates that aren't tool calls", () => {
		const notification: SessionNotification = {
			sessionId: "session-1",
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
		};

		expect(checkAcpUpdateInvariants(notification, { terminalMetaCapable: false })).toEqual([]);
	});
});
