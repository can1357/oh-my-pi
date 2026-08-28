import { afterEach, describe, expect, test, vi } from "bun:test";
import * as core from "@tauri-apps/api/core";
import type { RpcBridge } from "../src/rpc/bridge";
import { exportSession, renameSession, SESSION_DETACHED } from "../src/rpc/sessionOps";

/**
 * The rule this module exists to keep: a throwaway child reaches the session
 * through `switch_session`, so pointing one at a jsonl another sidecar has open
 * is two agents appending to one file. Leaving the session route unmounts every
 * view while the pool keeps the sidecars, so "this webview has no bridge" is
 * exactly the state that must not reach `agent_oneshot`.
 */
const TARGET = { cwd: "/work", sessionPath: "/sessions/a.jsonl" };

/** What the relay hands back: one line per id the caller waited on. */
const BOTH_ANSWERED = [JSON.stringify({ success: true, data: {} }), JSON.stringify({ success: true })];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("renameSession", () => {
	test("refuses a session whose process this webview cannot reach", async () => {
		const invoke = vi.spyOn(core, "invoke").mockResolvedValue(BOTH_ANSWERED);

		await expect(renameSession({ ...TARGET, process: { kind: "detached" } }, "hola")).rejects.toThrow(
			SESSION_DETACHED,
		);
		expect(invoke).not.toHaveBeenCalled();
	});

	test("renames a session with no process through a throwaway child", async () => {
		const invoke = vi.spyOn(core, "invoke").mockResolvedValue(BOTH_ANSWERED);

		await renameSession({ ...TARGET, process: { kind: "none" } }, "hola");

		const [command, args] = invoke.mock.calls[0];
		expect(command).toBe("agent_oneshot");
		expect((args as { lines: string[] }).lines.map(line => JSON.parse(line).type)).toEqual([
			"switch_session",
			"set_session_name",
		]);
	});

	test("renames through the process that already owns the file", async () => {
		const invoke = vi.spyOn(core, "invoke").mockResolvedValue(BOTH_ANSWERED);
		const named: string[] = [];
		const bridge = {
			setSessionName: async (name: string) => void named.push(name),
		} as unknown as RpcBridge;

		await renameSession({ ...TARGET, process: { kind: "mounted", bridge } }, "hola");

		expect(named).toEqual(["hola"]);
		expect(invoke).not.toHaveBeenCalled();
	});
});

describe("exportSession", () => {
	test("refuses a session whose process this webview cannot reach", async () => {
		const invoke = vi
			.spyOn(core, "invoke")
			.mockResolvedValue([
				JSON.stringify({ success: true }),
				JSON.stringify({ success: true, data: { path: "/tmp/out.html" } }),
			]);

		await expect(exportSession({ ...TARGET, process: { kind: "detached" } }, "/tmp/out.html")).rejects.toThrow(
			SESSION_DETACHED,
		);
		expect(invoke).not.toHaveBeenCalled();
	});
});
