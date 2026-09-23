import { afterEach, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

afterEach(() => vi.restoreAllMocks());

it("restores RPC todo edits and explicit clears after reloading the session", async () => {
	await using dir = await TempDir.create("@omp-rpc-todos-");
	const authStorage = createInMemoryAuthStorage();
	const sessionManager = SessionManager.create(dir.path(), dir.path());
	const session = new AgentSession({
		agent: new Agent(),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
		memoryEnabled: false,
	});
	const phases: TodoPhase[] = [{ name: "Plan", tasks: [{ content: "Review changes", status: "pending" }] }];
	const sessionPath = sessionManager.getSessionFile()!;
	const commands: RpcCommand[] = [
		{ type: "set_todos", phases },
		{ type: "switch_session", sessionPath },
		{ type: "get_state" },
		{ type: "set_todos", phases: [] },
		{ type: "switch_session", sessionPath },
		{ type: "get_state" },
	];
	const input = new Blob([commands.map(command => `${JSON.stringify(command)}\n`).join("")]).stream();
	let output = "";
	vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		output += typeof args[0] === "string" ? args[0] : Buffer.from(args[0] as Uint8Array).toString();
		const callback = args.at(-1);
		if (typeof callback === "function") callback();
		return true;
	});
	const exited = new Error("RPC exited");
	const exit = vi.spyOn(process, "exit").mockImplementation(() => {
		throw exited;
	});
	const notifications = process.env.PI_NOTIFICATIONS;
	try {
		await sessionManager.ensureOnDisk();
		await expect(runRpcMode(session, undefined, undefined, input)).rejects.toBe(exited);
		expect(exit).toHaveBeenCalledWith(0);
		const responses = (Bun.JSONL.parse(output) as RpcResponse[]).filter(frame => frame.type === "response");
		expect(responses.filter(frame => frame.command === "switch_session")).toEqual([
			{ type: "response", command: "switch_session", success: true, data: { cancelled: false } },
			{ type: "response", command: "switch_session", success: true, data: { cancelled: false } },
		]);
		const states = responses.filter(frame => frame.command === "get_state" && frame.success);
		expect(states.map(frame => frame.data.todoPhases)).toEqual([phases, []]);
	} finally {
		if (notifications === undefined) delete process.env.PI_NOTIFICATIONS;
		else process.env.PI_NOTIFICATIONS = notifications;
		await session.dispose();
		authStorage.close();
	}
});
