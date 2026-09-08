import { describe, expect, test } from "bun:test";
import { handleRpcCustomCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcCustomCommandSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

const makeSession = (delivered = false): RpcCustomCommandSession & {
	calls: Array<{ message: unknown; options?: unknown }>;
} => {
	const calls: Array<{ message: unknown; options?: unknown }> = [];
	return {
		calls,
		sendCustomMessage: async (message, options) => {
			calls.push({ message, options });
			return delivered;
		},
	};
};

describe("handleRpcCustomCommand", () => {
	test("forwards a hidden custom message and returns delivered", async () => {
		const session = makeSession(true);

		const result = await handleRpcCustomCommand(session, {
			type: "custom",
			customType: "host-context",
			content: "background note",
		});

		expect(result).toEqual({ delivered: true });
		expect(session.calls).toEqual([
			{
				message: {
					customType: "host-context",
					content: "background note",
					display: false,
					details: undefined,
					attribution: undefined,
				},
				options: {},
			},
		]);
	});

	test("passes display, deliverAs, and triggerTurn when provided", async () => {
		const session = makeSession(false);

		const result = await handleRpcCustomCommand(session, {
			type: "custom",
			customType: "visible-card",
			content: "shown to user",
			display: true,
			deliverAs: "nextTurn",
			triggerTurn: true,
		});

		expect(result).toEqual({ delivered: false });
		expect(session.calls[0]?.message).toEqual({
			customType: "visible-card",
			content: "shown to user",
			display: true,
			details: undefined,
			attribution: undefined,
		});
		expect(session.calls[0]?.options).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
	});

	test("rejects whitespace-only customType", async () => {
		const session = makeSession();

		const result = await handleRpcCustomCommand(session, {
			type: "custom",
			customType: "   ",
			content: "note",
		});

		expect(result).toEqual({ error: "customType must be a non-empty string" });
		expect(session.calls).toHaveLength(0);
	});

	test("rejects missing customType", async () => {
		const session = makeSession();

		const result = await handleRpcCustomCommand(session, {
			type: "custom",
			content: "note",
		} as Parameters<typeof handleRpcCustomCommand>[1]);

		expect(result).toEqual({ error: "customType must be a non-empty string" });
		expect(session.calls).toHaveLength(0);
	});

	test("rejects missing content", async () => {
		const session = makeSession();

		const result = await handleRpcCustomCommand(session, {
			type: "custom",
			customType: "host-context",
			content: undefined as unknown as string,
		});

		expect(result).toEqual({ error: "content must be a string" });
		expect(session.calls).toHaveLength(0);
	});

	test("rejects invalid deliverAs", async () => {
		const session = makeSession();

		const result = await handleRpcCustomCommand(session, {
			type: "custom",
			customType: "host-context",
			content: "note",
			deliverAs: "now" as "steer",
		});

		expect(result).toEqual({ error: "Invalid deliverAs: now" });
		expect(session.calls).toHaveLength(0);
	});

	test("rejects non-boolean display", async () => {
		const session = makeSession();

		const result = await handleRpcCustomCommand(session, {
			type: "custom",
			customType: "host-context",
			content: "note",
			display: "yes" as unknown as boolean,
		});

		expect(result).toEqual({ error: "display must be a boolean" });
		expect(session.calls).toHaveLength(0);
	});

	test("rejects non-boolean triggerTurn", async () => {
		const session = makeSession();

		const result = await handleRpcCustomCommand(session, {
			type: "custom",
			customType: "host-context",
			content: "note",
			triggerTurn: 1 as unknown as boolean,
		});

		expect(result).toEqual({ error: "triggerTurn must be a boolean" });
		expect(session.calls).toHaveLength(0);
	});
});
