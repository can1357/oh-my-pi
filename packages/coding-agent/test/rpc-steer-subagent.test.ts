import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { IrcBus, type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { RpcClient, RpcCommandError } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { handleRpcSteerSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import {
	RpcSubagentRegistry,
	type RpcSubagentSteerResolution,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("RPC steer_subagent resolution", () => {
	let registry: RpcSubagentRegistry;
	let eventBus: EventBus;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		eventBus = new EventBus();
		registry = new RpcSubagentRegistry(eventBus, () => {});
	});

	afterEach(() => {
		registry.dispose();
	});

	function startSubagent(id: string, overrides: Partial<SubagentLifecyclePayload> = {}): void {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile: `/tmp/${id}.jsonl`,
			...overrides,
		} satisfies SubagentLifecyclePayload);
	}

	function snapshotOf(id: string): RpcSubagentSteerResolution {
		return registry.resolveForSteer(id);
	}

	test("resolves a live in-process subagent as running (id joins to the hub recipient)", () => {
		startSubagent("SubagentA");
		expect(snapshotOf("SubagentA")).toMatchObject({ kind: "running" });
	});

	test("resolves an unknown id as unknown", () => {
		expect(snapshotOf("Nobody")).toEqual({ kind: "unknown" });
	});

	test("resolves a released subagent as not-running", () => {
		startSubagent("SubagentA");
		expect(snapshotOf("SubagentA")).toMatchObject({ kind: "running" });

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile: "/tmp/SubagentA.jsonl",
		} satisfies SubagentLifecyclePayload);

		expect(snapshotOf("SubagentA")).toEqual({ kind: "not-running" });
	});

	test("retains the isolated marker on progress updates", () => {
		startSubagent("Iso", { isolated: true });
		registry.handleProgress({
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Isolated work",
			sessionFile: "/tmp/Iso.jsonl",
			progress: {
				index: 0,
				id: "Iso",
				agent: "task",
				agentSource: "bundled",
				status: "running",
				task: "Isolated work",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			},
		});
		const resolution = snapshotOf("Iso");
		expect(resolution).toMatchObject({ kind: "running" });
		if (resolution.kind === "running") {
			expect(resolution.snapshot.isolated).toBe(true);
		}
	});
});

describe("handleRpcSteerSubagent", () => {
	let registry: RpcSubagentRegistry;
	let eventBus: EventBus;
	let received: IrcMessage | undefined;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		received = undefined;
		eventBus = new EventBus();
		registry = new RpcSubagentRegistry(eventBus, () => {});
	});

	afterEach(() => {
		registry.dispose();
	});

	function startSubagent(id: string, overrides: Partial<SubagentLifecyclePayload> = {}): void {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile: `/tmp/${id}.jsonl`,
			...overrides,
		} satisfies SubagentLifecyclePayload);
	}

	/** Register an in-process fake agent whose session records IRC delivery. */
	function registerInProcessAgent(id: string): number {
		let delivered = 0;
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: {
				deliverIrcMessage: async (msg: IrcMessage) => {
					received = msg;
					delivered += 1;
					return "injected";
				},
			} as never,
			sessionFile: `/tmp/${id}.jsonl`,
			status: "running",
		});
		return delivered;
	}

	test("delivers a steering DM attributed to the session owner to an in-process subagent", async () => {
		startSubagent("SubagentA");
		registerInProcessAgent("SubagentA");

		const result = await handleRpcSteerSubagent(registry, "SubagentA", "Refocus on the direct path");

		expect(result).toEqual({ kind: "delivered", to: "SubagentA", outcome: "injected" });
		expect(received).toMatchObject({
			from: MAIN_AGENT_ID,
			to: "SubagentA",
			body: "Refocus on the direct path",
		});
	});

	test("errors with unknown subagent for an unregistered id", async () => {
		await expect(handleRpcSteerSubagent(registry, "Nobody", "hi")).resolves.toEqual({
			kind: "error",
			message: "Unknown subagent: Nobody",
		});
	});

	test("errors with subagent not running for a released id", async () => {
		startSubagent("SubagentA");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile: "/tmp/SubagentA.jsonl",
		} satisfies SubagentLifecyclePayload);

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hello")).resolves.toEqual({
			kind: "error",
			message: "Subagent not running: SubagentA",
		});
	});

	test("errors with unsupported_isolated for an isolated worktree subagent without delivering", async () => {
		startSubagent("Iso", { isolated: true });
		registerInProcessAgent("Iso");

		const result = await handleRpcSteerSubagent(registry, "Iso", "hello");

		expect(result).toEqual({
			kind: "error",
			message: "Subagent Iso runs in an isolation worktree and cannot be steered over the hub yet.",
			code: "unsupported_isolated",
		});
		expect(received).toBeUndefined();
	});

	test("reports a failed bus delivery as an error", async () => {
		startSubagent("Ghost");
		// Lifecycle says running, but no AgentRegistry ref (session already released):
		// the bus cannot resolve a recipient and reports a failed receipt.
		const result = await handleRpcSteerSubagent(registry, "Ghost", "hello");
		expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("Delivery failed") });
	});
});

describe("RpcClient steerSubagent wrapper", () => {
	const tempPaths: string[] = [];

	afterEach(() => {
		for (const tempPath of tempPaths.splice(0)) {
			removeSyncWithRetries(tempPath);
		}
	});

	function writeFakeCli(responder: string): string {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-steer-client-${Snowflake.next()}.js`);
		tempPaths.push(scriptPath);
		Bun.write(
			scriptPath,
			`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "steer_subagent") {
		${responder}
		return;
	}
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);
		return scriptPath;
	}

	test("dispatches the steer_subagent wire frame and surfaces the delivery receipt", async () => {
		const scriptPath = writeFakeCli(
			`write({ id: frame.id, type: "response", command: "steer_subagent", success: true, data: { to: frame.subagentId, outcome: "injected" } });`,
		);
		using client = new RpcClient({ cliPath: scriptPath });
		await client.start();

		await expect(client.steerSubagent("OmpWorker", "Hold on")).resolves.toEqual({
			to: "OmpWorker",
			outcome: "injected",
		});
		await client.promptAndWait("done");
	});

	test("surfaces the server error code for isolated subagents", async () => {
		const scriptPath = writeFakeCli(
			`write({ id: frame.id, type: "response", command: "steer_subagent", success: false, error: "Subagent Iso runs in an isolation worktree", code: "unsupported_isolated" });`,
		);
		using client = new RpcClient({ cliPath: scriptPath });
		await client.start();

		const rejection = await client.steerSubagent("Iso", "hello").then(
			() => null,
			(error: unknown) => error,
		);
		expect(rejection).toBeInstanceOf(RpcCommandError);
		if (rejection instanceof RpcCommandError) {
			expect(rejection.code).toBe("unsupported_isolated");
			expect(rejection.command).toBe("steer_subagent");
		}
		await client.promptAndWait("done");
	});
});
