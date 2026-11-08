import { parentPort } from "node:worker_threads";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AuthStorage } from "../../src/session/auth-storage";
import { runStructuredSubagent } from "../../src/task/structured-subagent";
import type { AgentDefinition } from "../../src/task/types";
import { setCurrentThreadId } from "../../src/thread/identity";
import type { SubagentWorkerInit, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import type { ToolSession } from "../../src/tools";

export interface RetainedArtifactsProbe {
	run(root: string): Promise<{ dir: string; exitCode: number; hasCleanup: boolean }>;
	cleanup(): Promise<void>;
	barrier(): Promise<void>;
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");
let frameHandler: ((frame: RpcFrame) => void) | undefined;
let cleanup: (() => Promise<void>) | undefined;

const probe: RetainedArtifactsProbe = {
	async run(root) {
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("mock", "test-key");
		registerMockApi("retained-artifacts-worker");
		const mock = createMockModel({ id: "retained-artifacts-worker", responses: [{ content: ["retained answer"] }] });
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		modelRegistry.find = (provider, id) => (provider === "mock" && id === mock.model.id ? mock.model : undefined);
		modelRegistry.getAvailable = () => [mock.model];
		const agent: AgentDefinition = {
			name: "retained-worker",
			description: "Retained worker",
			systemPrompt: "Answer.",
			source: "bundled",
			tools: [],
			model: [`mock/${mock.model.id}`],
		};
		const session = {
			cwd: root,
			hasUI: false,
			settings: Settings.isolated({
				"task.isolation.enabled": false,
				"task.agentIdleTtlMs": 0,
				"retry.enabled": false,
				"launch.enabled": false,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionAgents: () => [agent],
			getAgentId: () => "Main",
			authStorage,
			modelRegistry,
			restrictToolNames: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
		} as unknown as ToolSession;
		const result = await runStructuredSubagent({
			session,
			invocationKind: "eval",
			assignment: "Answer.",
			agent: agent.name,
			identity: { id: "WorkerArtifactsOwner" },
			structured: false,
			keepAlive: true,
			retainArtifacts: true,
			onArtifactsRetained: callback => {
				cleanup = callback;
			},
		});
		return { dir: result.artifactsDir, exitCode: result.result.exitCode, hasCleanup: cleanup !== undefined };
	},
	async cleanup() {
		if (!cleanup) throw new Error("run did not provide retained cleanup");
		await cleanup();
	},
	async barrier() {},
};

const services: ThreadService[] = [identityThreadService, agentsThreadService];
port.on("message", (message: SubagentWorkerInit | RpcFrame) => {
	if (frameHandler) {
		if ("t" in message) frameHandler(message);
		return;
	}
	if (!("type" in message) || message.type !== "subagent-worker-init") return;
	setCurrentThreadId(message.threadId);
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				frameHandler = handler;
				return () => {
					frameHandler = undefined;
				};
			},
		},
		{
			name: "retained-artifacts-fixture",
			sync: { port: message.replyPort, counter: new Int32Array(message.counter) },
		},
	);
	for (const service of services) service.installWorker?.(link);
	link.handle("boot", async globals => {
		for (const service of services) await service.boot?.(globals[service.name], link);
		const register = globals.retainedArtifacts as { ready: (probe: RetainedArtifactsProbe) => Promise<void> };
		await register.ready(probe);
	});
	link.handle("ping", nonce => nonce);
	port.postMessage({ type: "subagent-worker-ready" });
});
