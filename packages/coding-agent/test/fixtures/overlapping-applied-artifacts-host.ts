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
const before = mode.endsWith("before");
const cwd = path.join(root, "project");
async function initRepo(dir: string, file: string, text: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await $`git init -q`.cwd(dir).quiet();
	await $`git config user.name Probe`.cwd(dir).quiet();
	await $`git config user.email probe@example.invalid`.cwd(dir).quiet();
	await Bun.write(path.join(dir, file), text);
	await $`git add ${file}`.cwd(dir).quiet();
	await $`git commit -qm initial`.cwd(dir).quiet();
}
await initRepo(cwd, "file.txt", "original\n");
const authStorage = await AuthStorage.create(":memory:");
authStorage.keys.setRuntime("mock", "test-key");
registerMockApi("overlapping-recovery");
let response = 0;
const model = createMockModel({
	id: "overlapping-recovery",
	handler: () => {
		const turn = response++;
		if (turn === 0) {
			return {
				content: [
					{ type: "toolCall", name: "write", arguments: { path: "file.txt", content: "applied original work\n" } },
				],
			};
		}
		return { content: ["done"] };
	},
});
const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
const find = modelRegistry.find.bind(modelRegistry);
modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
modelRegistry.getAvailable = () => [model];
const agent: AgentDefinition = {
	name: "late",
	description: "Write work",
	systemPrompt: "Write file.",
	source: "bundled",
	tools: ["write"],
	model: [`mock/${model.id}`],
};
const session = {
	cwd,
	hasUI: false,
	settings: Settings.isolated({
		"task.isolation.enabled": true,
		"isolation.backend": "rcopy",
		"task.agentIdleTtlMs": 0,
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
async function release(): Promise<void> {
	const ref = AgentRegistry.global().get("Late");
	assert(ref?.session, "agent must still be live at the release checkpoint");
	const workdir = ref.session.sessionManager.getCwd();
	assert.notEqual(workdir, cwd);
	assert(await AgentLifecycleManager.global().release("Late"));
	assert.equal(
		await fs.stat(workdir).then(
			() => true,
			() => false,
		),
		false,
		"release must remove the isolated tree",
	);
}
const originalFile = Bun.file.bind(Bun);
let intercepted = false;
// Hold only completion of the real patch read: capture, apply and release stay real.
Bun.file = ((input, ...options) => {
	const file = Reflect.apply(originalFile, Bun, [input, ...options]) as Bun.BunFile;
	if (typeof input !== "string" || !input.endsWith("/Late.patch")) return file;
	return new Proxy(file, {
		get(target, key) {
			if (key === "text")
				return async () => {
					const text = await target.text();
					if (!intercepted) {
						intercepted = true;
						assert.equal(await originalFile(path.join(cwd, "file.txt")).text(), "original\n");
						if (before) await release();
					}
					return text;
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}) as typeof Bun.file;
const settled = await runStructuredSubagent({
	session,
	invocationKind: "eval",
	assignment: "write initial work",
	agent: agent.name,
	structured: false,
	identity: { id: "Late" },
	keepAlive: true,
	retainArtifacts: true,
	isolation: { requested: true, apply: true, merge: "patch" },
	onArtifactsRetained: owner => {
		cleanup = owner;
	},
});
Bun.file = originalFile;
assert(intercepted, "probe must intercept the actual merge read");
assert.equal(settled.changesApplied, true, settled.mergeSummary);
assert.equal(settled.result.exitCode, 0);
assert.equal(await Bun.file(path.join(cwd, "file.txt")).text(), "applied original work\n");
if (!before) await release();
await AgentLifecycleManager.global().dispose();
assert.equal(AgentRegistry.global().list().length, 0);
assert(cleanup);
await cleanup();
assert.equal(
	await fs.stat(settled.artifactsDir).then(
		() => true,
		() => false,
	),
	false,
);
authStorage.close();
process.stdout.write(`RESULT ${JSON.stringify({ artifactsDir: settled.artifactsDir })}\n`);
process.exit(0);
