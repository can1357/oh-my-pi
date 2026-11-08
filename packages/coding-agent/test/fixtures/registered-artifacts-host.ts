import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { HistoryProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/history-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { resolveEffectiveSubagentPolicy } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { WorkPool } from "@oh-my-pi/pi-coding-agent/task/workpool";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const root = process.env.PROBE_ROOT!;
const cwd = path.join(root, "project");
await fs.promises.mkdir(cwd, { recursive: true });
const authStorage = await AuthStorage.create(":memory:");
authStorage.keys.setRuntime("mock", "test-key");
registerMockApi("registered-artifacts-host");
const mode = process.argv[2];
const firstWorkerEntered = Promise.withResolvers<void>();
const releaseFirstWorker = Promise.withResolvers<void>();
let workersEntered = 0;
const model = createMockModel({
	id: "registered-artifacts-host",
	handler: async () => {
		if (mode === "pool" && workersEntered++ === 0) {
			firstWorkerEntered.resolve();
			await releaseFirstWorker.promise;
		}
		return {
			content: [
				{
					type: "toolCall",
					name: "yield",
					arguments: mode === "pool" ? { key: 1, data: { answer: "done" } } : { data: { answer: "done" } },
				},
			],
		};
	},
});
const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
const find = modelRegistry.find.bind(modelRegistry);
modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
modelRegistry.getAvailable = () => [model];
const agent: AgentDefinition = {
	name: "registered-worker",
	description: "Registered worker",
	systemPrompt: "Submit result.",
	source: "bundled",
	tools: ["yield"],
	model: [`mock/${model.id}`],
};
const manager = new AsyncJobManager({
	retentionMs: 60_000,
	retainedArtifactsCleanupGraceMs: 0,
	consumedResultEvictionMs: 60_000,
});
const session = {
	cwd,
	hasUI: false,
	settings: Settings.isolated({
		"task.maxRecursionDepth": 2,
		"task.isolation.enabled": false,
		"task.maxConcurrency": 2,
		"task.agentIdleTtlMs": 0,
		"launch.enabled": false,
	}),
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	getSessionAgents: () => [agent],
	getPlanModeState: () => undefined,
	getAgentId: () => "Main",
	authStorage,
	modelRegistry,
	asyncJobManager: manager,
	restrictToolNames: true,
	enableMCP: false,
	enableLsp: false,
	enableIrc: false,
} as unknown as ToolSession;
let jobId: string;
if (mode === "agent") {
	jobId = (await runEvalAgent({ prompt: "answer", agent: agent.name, label: "ReviveMe" }, { session })).id;
} else {
	const policy = await resolveEffectiveSubagentPolicy({
		session,
		invocationKind: "eval",
		assignment: "pool",
		agent: agent.name,
	});
	const pool = new WorkPool(session, { name: "registeredPool", policy });
	pool.push(["first"]);
	await firstWorkerEntered.promise;
	assert.equal(
		AgentRegistry.global()
			.list()
			.filter(ref => ref.kind === "sub").length,
		1,
	);
	pool.push(["second"]);
	releaseFirstWorker.resolve();
	jobId = pool.name;
}
const job = manager.getJob(jobId)!;
await job.promise;
const registry = AgentRegistry.global();
const refs = registry.list().filter(ref => ref.kind === "sub");
assert(refs.length >= (mode === "agent" ? 1 : 2), "probe did not run its workers");
const agentHandler = new AgentProtocolHandler();
const historyHandler = new HistoryProtocolHandler();
const before = new Map<string, string>();
for (const ref of refs) {
	assert(ref.sessionFile);
	assert.equal(ref.status, "idle");
	before.set(ref.id, await Bun.file(ref.sessionFile).text());
}
const cleanup = job.retainedArtifactsCleanup;
assert(cleanup, "job never acquired the retained artifacts");
const cleaned = Promise.withResolvers<void>();
job.retainedArtifactsCleanup = async () => {
	try {
		await cleanup();
		cleaned.resolve();
	} catch (error) {
		cleaned.reject(error);
		throw error;
	}
};
manager.evictCompletedJobs({ ownerId: "Main" });
await cleaned.promise;
for (const ref of refs) {
	assert.equal(registry.get(ref.id), ref, "agent must still be registered after row eviction");
	const url = parseInternalUrl(`agent://${ref.id}`);
	const located = await agentHandler.locate(url);
	assert(located, "job eviction lost the published agent output");
	const output = await agentHandler.resolve(url);
	assert.equal(typeof output.content, "string");
	assert(String(output.content).includes("done"), "agent URL lost the published answer");
	const transcript = await historyHandler.locate(parseInternalUrl(`history://${ref.id}`));
	assert(transcript);
	assert.equal(await Bun.file(transcript).text(), before.get(ref.id));
	await AgentLifecycleManager.global().park(ref.id);
	const revived = await AgentLifecycleManager.global().ensureLive(ref.id);
	assert(revived.messages.length >= 3, "cold revival lost its conversation");
	const dir = path.dirname(ref.sessionFile!);
	const removed = Promise.withResolvers<void>();
	const watcher = fs.watch(path.dirname(dir), (_event, name) => {
		if (name === path.basename(dir) && !fs.existsSync(dir)) removed.resolve();
	});
	try {
		await AgentLifecycleManager.global().release(ref.id);
		await removed.promise;
		assert(!fs.existsSync(dir), "unregistered lease was never reclaimed");
	} finally {
		watcher.close();
	}
}
await AgentLifecycleManager.global().dispose();
await manager.dispose();
authStorage.close();
process.stdout.write(
	`RESULT ${mode}: published output, transcript and cold revival survive eviction; release reclaims the lease\n`,
);
process.exit(0);
