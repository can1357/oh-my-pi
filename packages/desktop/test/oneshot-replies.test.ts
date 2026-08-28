import { describe, expect, test } from "bun:test";
import { readOneshotReplies } from "../src/rpc/sessionOps";

/**
 * The throwaway sidecar runs two commands and used to read only the second.
 *
 * Both of the switch's real failure shapes answer `success: true` — an
 * extension's `session_before_switch` handler cancelling, and `switchSession`
 * refusing a cwd change because rpc-mode passes no `onCwdChange` — so a rename
 * that landed on the child's own empty session reported success. The `path` vs
 * `sessionPath` bug reached the same place through a different door.
 */

/** A response frame, in the shape rpc-mode's `success`/`error` helpers emit. */
function reply(id: string, body: object): string {
	return JSON.stringify({ id, type: "response", ...body });
}

const SWITCHED = reply("oneshot-switch-1", {
	command: "switch_session",
	success: true,
	data: { cancelled: false },
});
const RENAMED = reply("oneshot-run-1", { command: "set_session_name", success: true });

describe("a oneshot is only as good as its switch", () => {
	test("a cancelled switch fails the whole operation", () => {
		const cancelled = reply("oneshot-switch-1", {
			command: "switch_session",
			success: true,
			data: { cancelled: true },
		});
		expect(() => readOneshotReplies([cancelled, RENAMED])).toThrow(/refused to open/);
	});

	test("a switch that errored fails with the server's own message", () => {
		const failed = reply("oneshot-switch-1", {
			command: "switch_session",
			success: false,
			error: "no such session",
		});
		expect(() => readOneshotReplies([failed, RENAMED])).toThrow("no such session");
	});

	test("a switch that worked lets the command's own answer through", () => {
		const exported = reply("oneshot-run-1", {
			command: "export_html",
			success: true,
			data: { path: "/tmp/session.html" },
		});
		expect(readOneshotReplies<{ path: string }>([SWITCHED, exported])).toEqual({ path: "/tmp/session.html" });
	});

	test("the command's own failure still surfaces", () => {
		const refused = reply("oneshot-run-1", {
			command: "set_session_name",
			success: false,
			error: "Session name cannot be empty",
		});
		expect(() => readOneshotReplies([SWITCHED, refused])).toThrow("Session name cannot be empty");
	});

	test("one reply for two commands is a failure, not half a success", () => {
		expect(() => readOneshotReplies([RENAMED])).toThrow(/of 2/);
	});
});
