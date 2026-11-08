/**
 * Host process for the retained-artifacts lifetime test.
 *
 * Runs one subagent whose temporary artifacts directory is retained past the
 * run (`retainArtifacts`, the shape eval's `agent()` and `workpool()` use),
 * prints the directory, and then ends the way the test asked: by returning
 * from main, or by waiting for the signal the test sends. The test checks
 * from outside whether the directory survived the process.
 *
 * Usage: `bun retained-artifacts-host.ts <exit|sigterm|no-retain|throw|abort>`
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { postmortem } from "@oh-my-pi/pi-utils";

const mode = process.argv[2] ?? "exit";
if (mode === "sigterm") postmortem.installProcessHandlers();

const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-retained-artifacts-host-"));
const cwd = path.join(root, "project");
await fs.mkdir(cwd, { recursive: true });

const authStorage = await AuthStorage.create(":memory:");
authStorage.keys.setRuntime("mock", "test-key");
registerMockApi("retained-artifacts-host");
const controller = new AbortController();
const entered = Promise.withResolvers<void>();
const model = createMockModel({
	id: "retained-artifacts-host",
	handler: async (_context, options) => {
		if (mode === "throw") throw new Error("model failed without salvageable work");
		if (mode === "abort") {
			entered.resolve();
			const aborted = Promise.withResolvers<void>();
			options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
		}
		return { content: ["done"] };
	},
});
const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
const find = modelRegistry.find.bind(modelRegistry);
modelRegistry.find = (provider, id) => (provider === "mock" && id === model.id ? model : find(provider, id));
modelRegistry.getAvailable = () => [model];

const agent: AgentDefinition = {
	name: "retained-artifacts-worker",
	description: "Retained artifacts host worker",
	systemPrompt: "Answer directly.",
	source: "bundled",
	tools: ["read"],
	model: [`mock/${model.id}`],
};

const session = {
	cwd,
	hasUI: false,
	settings: Settings.isolated({ "task.maxRecursionDepth": 2, "task.isolation.enabled": false }),
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

const agentId = "RetainedArtifactsWorker";
const pending = runStructuredSubagent({
	session,
	invocationKind: "eval",
	assignment: "Answer directly.",
	agent: agent.name,
	structured: false,
	identity: { id: agentId },
	keepAlive: false,
	// The leaking shape: the run keeps its temporary directory so a later
	// `agent://<id>` still resolves, and names no owner to dispose it.
	retainArtifacts: mode === "exit" || mode === "sigterm",
	signal: controller.signal,
});
if (mode === "abort") {
	await entered.promise;
	controller.abort();
}
const settled = await pending;
if (mode === "abort") assert(settled.result.aborted, "probe never aborted a running agent");
if (mode === "throw") assert(settled.result.error || settled.result.exitCode !== 0, "probe never failed its child");
const existsAfterRun = await fs.stat(settled.artifactsDir).then(
	() => true,
	() => false,
);
assert.equal(existsAfterRun, mode === "exit" || mode === "sigterm", "unexpected retention after the run returns");

await AgentRegistry.global().get(agentId)?.session?.dispose();
AgentRegistry.global().unregister(agentId);
await fs.rm(root, { recursive: true, force: true });

process.stdout.write(`ARTIFACTS ${settled.artifactsDir}\n`);

if (mode === "sigterm") {
	// Stay alive until the test signals; the signal handler owns the exit.
	await new Promise(() => {});
} else {
	authStorage.close();
	process.exit(0);
}
