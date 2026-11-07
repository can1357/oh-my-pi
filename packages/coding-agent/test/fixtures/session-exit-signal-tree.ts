/**
 * An omp process tree for session-exit-context.test.ts: an SDK parent session
 * and two subagents homed on a pooled worker thread, torn down by a real
 * signal through postmortem, the way the interactive mode tears down.
 *
 * - The parent is built by `createAgentSession` and answers one prompt. Its
 *   postmortem teardown (`session.dispose({ reason })`) is registered before
 *   the pool exists, as the interactive mode registers it at start-up.
 * - `SignalIdle` runs to completion and stays alive (kept alive, idle) on the
 *   worker, so only the parent's lifecycle teardown disposes it.
 * - `SignalBusy` is still running its first tool call (a `bash` sleep) on the
 *   worker when the signal comes.
 *
 * A scripted OpenAI-compatible server stands in for the model. Once both
 * subagents are in place it prints `READY {parent, idle, busy}` (session
 * files) and waits for a signal. Usage: <root dir>; HOME comes from the
 * environment and decides the exit-intent directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type ExecutorOptions, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { RemoteAgentSession } from "@oh-my-pi/pi-coding-agent/thread/remote-agent-session";
import {
	registerSubagentWorkerPoolShutdown,
	SubagentWorkerPool,
	setSubagentWorkerPoolForTests,
} from "@oh-my-pi/pi-coding-agent/thread/subagent-worker";
import { postmortem } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

postmortem.installProcessHandlers();

const root = process.argv[2];
if (!root) throw new Error("usage: <root dir>");
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir, { recursive: true });
const busyMarker = path.join(root, "busy-started");

function sse(delta: Record<string, unknown>, finish: string): string {
	const base = { id: "chatcmpl-signal", object: "chat.completion.chunk", created: 0, model: "signal-model" };
	const frames = [
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
		{ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
	];
	return `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}

function toolCall(name: string, args: Record<string, unknown>): string {
	return sse(
		{
			role: "assistant",
			tool_calls: [
				{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
			],
		},
		"tool_calls",
	);
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "signal-model" }] });
		const body = JSON.stringify(await request.json());
		const headers = { "content-type": "text/event-stream" };
		// The busy subagent's first turn starts a long tool call; every other turn finishes.
		if (body.includes("SIGNAL_BUSY") && !body.includes('"role":"tool"')) {
			return new Response(toolCall("bash", { command: `touch '${busyMarker}' && sleep 120` }), { headers });
		}
		if (body.includes('"name":"yield"')) return new Response(toolCall("yield", { data: "done" }), { headers });
		return new Response(sse({ role: "assistant", content: "parent done" }, "stop"), { headers });
	},
});

const modelsPath = path.join(agentDir, "models.yml");
fs.writeFileSync(
	modelsPath,
	[
		"providers:",
		"  signal:",
		`    baseUrl: http://127.0.0.1:${server.port}/v1`,
		"    auth: none",
		"    api: openai-completions",
		"    models:",
		"      - id: signal-model",
		"        name: Signal Model",
		"        reasoning: false",
		"        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
		"",
	].join("\n"),
);
const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage, modelsPath);
await modelRegistry.refresh();
const model = modelRegistry.find("signal", "signal-model");
if (!model) throw new Error("scripted model missing");
const settings = Settings.isolated({
	"task.agentIdleTtlMs": 600_000,
	"task.completionProbe": false,
	"task.isolation.enabled": false,
	"compaction.enabled": false,
	"retry.enabled": false,
	"todo.enabled": false,
	"todo.reminders": false,
	"advisor.enabled": false,
	"skills.enabled": false,
	modelRoles: { default: "signal/signal-model" },
});
const sessionManager = SessionManager.create(root, path.join(root, "parent"));
const { session: parent } = await createAgentSession({
	cwd: root,
	agentDir,
	authStorage,
	modelRegistry,
	model,
	settings,
	sessionManager,
	disableExtensionDiscovery: true,
	skills: [],
	contextFiles: [],
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
	skipPythonPreflight: true,
	rules: [],
	preloadedCustomToolPaths: [],
	toolNames: ["read"],
});
// Registered before the pool, as the interactive mode registers its teardown at start-up.
postmortem.register("session-teardown", reason => parent.dispose({ reason }));
await parent.prompt("parent run");

const pool = new SubagentWorkerPool({
	maxWorkers: () => 1,
	hostsOnMain: false,
	idleMs: 600_000,
	worker: { initTimeoutMs: 60_000 },
});
setSubagentWorkerPoolForTests(pool);
// What `subagentWorkerPool()` does when it creates the process pool, after the teardown above.
registerSubagentWorkerPoolShutdown(pool);

function subagent(id: string, task: string, tools: string[]): ExecutorOptions {
	return {
		cwd: root,
		agent: { name: "task", description: "signal tree subagent", systemPrompt: "Finish.", source: "bundled", tools },
		task,
		index: 0,
		id,
		description: id,
		modelOverride: "signal/signal-model",
		structured: false,
		settings,
		authStorage,
		modelRegistry,
		artifactsDir: path.join(root, "artifacts"),
		sessionFile: sessionManager.getSessionFile(),
		enableLsp: false,
		enableMCP: false,
		taskDepth: 0,
		keepAlive: true,
		skills: [],
		contextFiles: [],
		rules: [],
		promptTemplates: [],
		preloadedCustomToolPaths: [],
	};
}

const idle = await runSubprocess(subagent("SignalIdle", "finish", ["read"]));
if (idle.exitCode !== 0) throw new Error(`idle subagent failed: ${JSON.stringify(idle)}`);
// Never awaited: the signal ends this run.
void runSubprocess(subagent("SignalBusy", "SIGNAL_BUSY", ["bash"])).catch(() => {});
const deadline = Date.now() + 60_000;
while (!fs.existsSync(busyMarker)) {
	if (Date.now() > deadline) throw new Error("the busy subagent never started its tool call");
	await Bun.sleep(20);
}

const sessionFileOf = (id: string): string => {
	const ref = AgentRegistry.global().get(id);
	if (!ref?.sessionFile) throw new Error(`no session file for ${id}`);
	if (!(ref.session instanceof RemoteAgentSession)) throw new Error(`${id} is not homed on a worker`);
	return ref.sessionFile;
};
process.stdout.write(
	`READY ${JSON.stringify({ parent: sessionManager.getSessionFile(), idle: sessionFileOf("SignalIdle"), busy: sessionFileOf("SignalBusy") })}\n`,
);
setInterval(() => {}, 60_000);
