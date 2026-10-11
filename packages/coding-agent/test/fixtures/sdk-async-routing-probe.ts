import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const mode = process.argv[2] ?? "collision";
assert.ok(["single", "collision", "unique", "reload"].includes(mode));
const profileDir = getAgentDir();
await fs.mkdir(profileDir, { recursive: true });
const root = await fs.mkdtemp(path.join(profileDir, "repro-async-routing-"));
const cwd = path.join(root, "work");
await fs.mkdir(cwd);
const marker = "REPRO_B_WAKE_ONLY";
const childId = "ReproChildB";
const sessions: AgentSession[] = [];
const auth = await AuthStorage.create(":memory:");
auth.keys.setRuntime("mock", "repro-key");
registerMockApi("repro-sdk-async-routing");
const model = createMockModel({
	handler: context => {
		if (context.tools?.some(tool => tool.name === "yield")) {
			if (context.messages.at(-1)?.role === "toolResult") return { content: ["done"] };
			const correction = JSON.stringify(context.messages).includes(marker);
			return {
				content: [
					{
						type: "toolCall",
						name: "yield",
						arguments: {
							type: "result",
							data: correction ? marker : "initial child result",
						},
					},
				],
			};
		}
		if (context.tools?.some(tool => tool.name === "task") && context.messages.at(-1)?.role === "user") {
			return {
				content: [
					{
						type: "toolCall",
						name: "task",
						arguments: {
							context: "Return an initial result. Keep the child available for a correction turn.",
							tasks: [
								{
									name: childId,
									agent: "task",
									task: "Return initial child result.",
									solutionSpace: "Report only.",
								},
							],
						},
					},
				],
			};
		}
		return { content: ["acknowledged"] };
	},
});
const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
const find = registry.find.bind(registry);
registry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
registry.getAvailable = () => [model];
const settings = Settings.isolated({
	"async.enabled": true,
	"task.batch": true,
	"task.maxConcurrency": 1,
	"task.agentIdleTtlMs": 0,
	"task.completionProbe": false,
	"compaction.enabled": false,
	"retry.enabled": false,
	"todo.enabled": false,
	"todo.reminders": false,
	"advisor.enabled": false,
	"autolearn.enabled": false,
	modelRoles: { default: "mock/mock-model" },
});
const create = async (
	name: string,
	tools: string[],
	agentId?: string,
	sessionManager?: AgentSession["sessionManager"],
) => {
	const { session } = await createAgentSession({
		cwd,
		agentDir: profileDir,
		authStorage: auth,
		modelRegistry: registry,
		model,
		settings,
		agentRegistry: new AgentRegistry(),
		agentId,
		sessionManager,
		disableExtensionDiscovery: true,
		preloadedExtensionPaths: [],
		preloadedCustomToolPaths: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		enableIrc: true,
		skipPythonPreflight: true,
		cacheWarming: false,
		toolNames: tools,
		restrictToolNames: true,
	});
	sessions.push(session);
	console.log(name, { sessionId: session.sessionId, hasManager: !!session.asyncJobManager });
	return session;
};
const deadline = setTimeout(() => {
	console.error("REPRO_TIMEOUT");
	for (const session of sessions) void session.abort();
}, 30_000);
try {
	let a: AgentSession | undefined;
	if (mode !== "single") {
		a = await create("A", [], mode === "unique" ? "RootA" : undefined);
		await a.prompt("A: unrelated task");
		if (mode === "reload") {
			const sessionFile = a.sessionFile!;
			await a.dispose();
			a = await create("A reloaded", [], undefined, await SessionManager.open(sessionFile));
		}
	}
	const b = await create("B", ["task"], mode === "unique" ? "RootB" : undefined);
	await b.prompt("B: launch child");
	if (b.asyncJobManager) {
		await b.asyncJobManager.waitForOwnerJobs(mode === "unique" ? "RootB" : MAIN_AGENT_ID);
		await b.asyncJobManager.drainDeliveries({ filter: { ownerId: mode === "unique" ? "RootB" : MAIN_AGENT_ID } });
		await b.waitForIdle();
	}
	const child = AgentRegistry.global().get(childId);
	assert.ok(child?.session, "B's task did not leave a live child");
	console.log("child", {
		parentId: child.parentId,
		sharesAManager: a ? child.session.asyncJobManager === a.asyncJobManager : undefined,
		sharesBManager: child.session.asyncJobManager === b.asyncJobManager,
		status: child.status,
	});
	assert.equal(child.status, "idle");
	const receipt = await IrcBus.global().send({ from: "ReproPeerB", to: childId, body: marker });
	console.log("IRC", receipt);
	assert.equal(receipt.outcome, "woken");
	await child.session.waitForIdle();
	const asyncManager = child.session.asyncJobManager;
	assert.ok(asyncManager);
	await asyncManager.waitForOwnerJobs(child.parentId!);
	await asyncManager.drainDeliveries({ filter: { ownerId: child.parentId } });
	await a?.waitForIdle();
	await b.waitForIdle();
	for (const session of sessions) await session.sessionManager.flush();
	const count = (session: AgentSession | undefined) =>
		session?.sessionManager
			.getEntries()
			.filter(
				entry =>
					entry.type === "custom_message" &&
					entry.customType === "async-result" &&
					JSON.stringify(entry).includes(marker),
			).length ?? 0;
	const diskA = a ? await fs.readFile(a.sessionFile!, "utf8") : "";
	const diskB = await fs.readFile(b.sessionFile!, "utf8");
	const result = {
		mode,
		aAsyncResults: count(a),
		bAsyncResults: count(b),
		markerOnDiskA: diskA.includes(marker),
		markerOnDiskB: diskB.includes(marker),
	};
	console.log("RESULT", JSON.stringify(result));
	assert.equal(result.aAsyncResults, 0, "BUG: B's correction async-result was delivered into A");
	assert.equal(result.bAsyncResults, 1, "BUG: B did not receive its child's correction async-result");
	assert.equal(result.markerOnDiskA, false, "BUG: B's correction was persisted in A");
	assert.equal(result.markerOnDiskB, true, "BUG: B's correction was not persisted in B");
} finally {
	clearTimeout(deadline);
	await AgentLifecycleManager.global().dispose();
	for (const session of sessions.toReversed()) await session.dispose();
	unregisterCustomApis("repro-sdk-async-routing");
	auth.close();
}
