import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleRpcSteerSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { PromptDroppedError } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

interface SentMessage {
	id: string;
	text: unknown;
	streamingBehavior: unknown;
}

/**
 * How the fake session answers `prompt`. `dropped` mirrors AgentSession: a
 * prompt dropped before dispatch (abort, disposal, usage preflight denial)
 * resolves `true` unless `throwOnDrop` asks for a {@link PromptDroppedError}.
 */
type Delivery = "queued" | "turn-started" | "dropped";

describe("handleRpcSteerSubagent", () => {
	let registry: RpcSubagentRegistry;
	let eventBus: EventBus;
	let sent: SentMessage[];
	let sessionDir: string;
	let ownSessionFile: string;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		sent = [];
		sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-steer-"));
		ownSessionFile = path.join(sessionDir, "SubagentA.jsonl");
		eventBus = new EventBus();
		registry = new RpcSubagentRegistry(eventBus, () => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registry.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		removeSyncWithRetries(sessionDir);
	});

	function emitLifecycle(id: string, status: SubagentLifecyclePayload["status"]): void {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status,
			sessionFile: ownSessionFile,
		} satisfies SubagentLifecyclePayload);
	}

	/**
	 * Register a live subagent whose session records `prompt` calls.
	 * `queued` resolves as a mid-turn steer does; `turn-started` emits
	 * `agent_start` and never settles, like a whole new turn.
	 */
	function registerLiveAgent(id: string, sessionFile = ownSessionFile, delivery: Delivery = "queued"): void {
		const listeners: Array<(event: { type: string }) => void> = [];
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: {
				subscribe: (listener: (event: { type: string }) => void) => {
					listeners.push(listener);
					return () => listeners.splice(listeners.indexOf(listener), 1);
				},
				prompt: async (text: unknown, options: { streamingBehavior?: unknown; throwOnDrop?: boolean }) => {
					sent.push({ id, text, streamingBehavior: options.streamingBehavior });
					if (delivery === "turn-started") {
						for (const listener of listeners) listener({ type: "agent_start" });
						await Promise.withResolvers<void>().promise;
					}
					if (delivery === "dropped" && options.throwOnDrop) throw new PromptDroppedError();
					return true;
				},
			} as never,
			sessionFile,
			status: "running",
		});
	}

	test("steers the subagent's own session with the message untrimmed", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		const message = "  fn main() {\n      todo!()\n  }\n";

		await expect(handleRpcSteerSubagent(registry, "SubagentA", message)).resolves.toBeUndefined();

		expect(sent).toEqual([{ id: "SubagentA", text: message, streamingBehavior: "steer" }]);
	});

	test("accepts once a new turn starts, without waiting for the turn", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", ownSessionFile, "turn-started");

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "go")).resolves.toBeUndefined();
	});

	test("reports a prompt the subagent dropped before dispatch as refused", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", ownSessionFile, "dropped");

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "go")).resolves.toBe(
			`Subagent refused the message: ${new PromptDroppedError().message}`,
		);
	});

	test("does not deliver when the id changes owner while the subagent is brought live", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		const original = AgentRegistry.global().get("SubagentA")?.session;
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockImplementation(async () => {
			// Another session's same-name agent replaces the ref during the await.
			registerLiveAgent("SubagentA", path.join(sessionDir, "other-session", "SubagentA.jsonl"));
			return original as never;
		});

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hi")).resolves.toBe(
			"Subagent not running: SubagentA",
		);
		expect(sent).toEqual([]);
	});

	test("does not reach another session's same-name subagent", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA", path.join(sessionDir, "other-session", "SubagentA.jsonl"));

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hi")).resolves.toBe(
			"Subagent not running: SubagentA",
		);
		expect(sent).toEqual([]);
	});

	test("does not reach a live agent this session never reported", async () => {
		registerLiveAgent("Stranger");

		await expect(handleRpcSteerSubagent(registry, "Stranger", "hi")).resolves.toBe("Subagent not running: Stranger");
		expect(sent).toEqual([]);
	});

	test("does not reach a subagent that already finished", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		emitLifecycle("SubagentA", "completed");

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hello")).resolves.toBe(
			"Subagent not running: SubagentA",
		);
		expect(sent).toEqual([]);
	});

	test("does not start a turn on a subagent whose result was accepted before its terminal frame", async () => {
		emitLifecycle("SubagentA", "started");
		registerLiveAgent("SubagentA");
		// Yield acceptance flips the ref to idle while the roster still lists it.
		AgentRegistry.global().markResultAccepted("SubagentA");

		await expect(handleRpcSteerSubagent(registry, "SubagentA", "hello")).resolves.toBe(
			"Subagent not running: SubagentA",
		);
		expect(sent).toEqual([]);
	});
});
