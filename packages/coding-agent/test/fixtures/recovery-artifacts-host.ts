import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { $ } from "bun";

const root = process.env.PROBE_ROOT!;
const mode = process.argv[2];
const nested = mode.startsWith("nested");
const applied = mode.startsWith("applied");
let creatingParent = nested;
let response = 0;
const cwd = path.join(root, "project");
await fs.mkdir(cwd, { recursive: true });
await $`git init -q`.cwd(cwd).quiet();
await $`git config user.name Probe`.cwd(cwd).quiet();
await $`git config user.email probe@example.invalid`.cwd(cwd).quiet();
await Bun.write(path.join(cwd, "file.txt"), "original\n");
await $`git add file.txt`.cwd(cwd).quiet();
await $`git commit -qm initial`.cwd(cwd).quiet();
const authStorage = await AuthStorage.create(":memory:");
authStorage.keys.setRuntime("mock", "test-key");
registerMockApi("recovery-artifacts-host");
const model = createMockModel({
	id: "recovery-artifacts-host",
	handler: () => {
		if (creatingParent || mode === "empty") return { content: ["nothing to change"] };
		if (response++ === 0) {
			return {
				content: [
					{ type: "toolCall", name: "write", arguments: { path: "file.txt", content: "recovered unique work\n" } },
				],
			};
		}
		return { content: ["change captured"] };
	},
});
const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
const find = modelRegistry.find.bind(modelRegistry);
modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
modelRegistry.getAvailable = () => [model];
const agent: AgentDefinition = {
	name: "recovery-worker",
	description: "Recovery worker",
	systemPrompt: "Write file.",
	source: "bundled",
	tools: ["write"],
	model: [`mock/${model.id}`],
};
const session = {
	cwd,
	hasUI: false,
	settings: Settings.isolated({
		"task.maxRecursionDepth": 2,
		"task.isolation.enabled": true,
		"task.isolation.apply": false,
		"isolation.backend": "rcopy",
		"launch.enabled": false,
	}),
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	getSessionAgents: () => [agent],
	getPlanModeState: () => undefined,
	authStorage,
	modelRegistry,
	restrictToolNames: true,
	enableMCP: false,
	enableLsp: false,
	enableIrc: false,
} as unknown as ToolSession;
let cleanup: (() => Promise<void>) | undefined;
let parentCleanup: (() => Promise<void>) | undefined;
let parentDir: string | undefined;
if (nested) {
	const parent = await runStructuredSubagent({
		session,
		invocationKind: "eval",
		assignment: "parent",
		agent: agent.name,
		structured: false,
		identity: { id: "Parent" },
		keepAlive: true,
		retainArtifacts: true,
		isolation: { requested: false },
		onArtifactsRetained: owner => {
			parentCleanup = owner;
		},
	});
	parentDir = parent.artifactsDir;
	const parentRef = AgentRegistry.global().get("Parent")!;
	assert(parentRef.sessionFile, "parent did not publish a transcript");
	session.getSessionFile = () => parentRef.sessionFile!;
	session.getAgentId = () => "Parent";
	session.taskDepth = 1;
	creatingParent = false;
}
const settled = await runStructuredSubagent({
	session,
	invocationKind: "task",
	assignment: "change file.txt",
	agent: agent.name,
	structured: false,
	identity: { id: nested ? "Parent.Child" : "RecoveryWorker" },
	keepAlive: mode === "applied-live",
	retainArtifacts: true,
	isolation: { requested: true, apply: applied, merge: "patch" },
	onArtifactsRetained: owner => {
		cleanup = owner;
	},
});
assert.equal(settled.result.exitCode, 0, settled.result.stderr);
assert(!settled.result.error, String(settled.result.error));
assert(settled.result.patchPath, "isolated run did not return a patch");
const patch = await Bun.file(settled.result.patchPath).text();
if (mode === "empty") assert.equal(patch, "");
else assert(patch.includes("+recovered unique work"), patch);
assert.equal(await Bun.file(path.join(cwd, "file.txt")).text(), applied ? "recovered unique work\n" : "original\n");
if (applied) assert.equal(settled.changesApplied, true, settled.mergeSummary);
if (nested) assert(settled.result.patchPath.startsWith(`${parentDir}${path.sep}`));
if (mode === "nested-mixed") {
	response = 0;
	const merged = await runStructuredSubagent({
		session,
		invocationKind: "task",
		assignment: "apply another child's work",
		agent: agent.name,
		structured: false,
		identity: { id: "Parent.Applied" },
		keepAlive: false,
		retainArtifacts: true,
		isolation: { requested: true, apply: true, merge: "patch" },
	});
	assert.equal(merged.changesApplied, true, merged.mergeSummary);
}
await AgentLifecycleManager.global().dispose();
const ownerDisposal = mode !== "exit" && mode !== "applied-exit" && mode !== "nested-exit";
if (ownerDisposal) {
	assert(cleanup || parentCleanup, "run did not hand artifacts to an owner");
	await cleanup?.();
	await parentCleanup?.();
}
const directory = parentDir ?? settled.artifactsDir;
const afterOwnerExists = await fs.stat(directory).then(
	() => true,
	() => false,
);
assert.equal(AgentRegistry.global().list().length, 0, "fixture left registered owners");
authStorage.close();
process.stdout.write(
	`RESULT ${JSON.stringify({ artifactsDir: directory, patchPath: settled.result.patchPath, patch, afterOwnerExists })}\n`,
);
process.exit(0);
