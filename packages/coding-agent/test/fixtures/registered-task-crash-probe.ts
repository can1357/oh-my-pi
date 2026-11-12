import { it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import * as fs from "node:fs/promises";

it("供父测试在真实宿主边界中止进程", async () => {
	const root = Bun.env.OMP_REGISTERED_TASK_PROBE_ROOT;
	const stage = Bun.env.OMP_REGISTERED_TASK_PROBE_STAGE;
	if (!root || (stage !== "before" && stage !== "after")) throw new Error("缺少隔离实验参数");
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [{ name: "task", description: "Task worker", systemPrompt: "Worker", source: "bundled" }],
		projectAgentsDir: null,
	});
	vi.spyOn(executor, "runSubprocess").mockImplementation(async () => {
		if (stage === "after") {
			const parentSessionFile = session.sessionManager.getSessionFile();
			const entries = await fs.readdir(root, { withFileTypes: true });
			const sessionFiles = entries
				.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
				.map(entry => `${root}/${entry.name}`);
			await Bun.write(`${root}/probe-state.json`, JSON.stringify({ parentSessionFile, sessionFiles }));
			process.stdout.write(`PROBE_READY:${parentSessionFile}\n`);
			const wait = Promise.withResolvers<void>();
			await wait.promise;
		}
		throw new Error("隔离实验不应运行模型");
	});
	if (stage === "before") {
		const register = AsyncJobManager.prototype.register;
		vi.spyOn(AsyncJobManager.prototype, "register").mockImplementation(function (type, label, run, options) {
			if (type === "task") {
				process.stdout.write(`PROBE_READY:${session.sessionManager.getSessionFile()}\n`);
				const wait = new Int32Array(new SharedArrayBuffer(4));
				for (;;) Atomics.wait(wait, 0, 0, 1000);
			}
			return register.call(this, type, label, run, options);
		});
	}
	const manager: ExtensionFactory = pi => {
		const pauseAfterResult = async () => {
			if (stage !== "after") return;
			await Promise.withResolvers<void>().promise;
		};
		pi.on("tool_result", async event => {
			if (event.toolName === "task") await pauseAfterResult();
		});
		pi.registerTool({
			name: "manager_test",
			label: "Manager",
			description: "Delegate an inspection.",
			parameters: type({ agent: "string", name: "string", task: "string" }),
			async execute(_id, args, _signal, _onUpdate, ctx) {
				if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
				return (await ctx.invokeRegisteredTask(args as Record<string, unknown>)).result;
			},
		});
	};
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		modelRegistry: new ModelRegistry(auth),
		model: createMockModel({ responses: [] }),
		sessionManager: SessionManager.create(root, root),
		settings: Settings.isolated({
			"async.enabled": true,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		}),
		extensions: [manager],
		trustedTaskDelegationExtensions: ["<inline-0>"],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["task", "wait"],
	});
	const tool = session.getToolForEvalBridge("manager_test");
	if (!tool) throw new Error("管理工具不可用");
	await tool.execute("outer-crash", { agent: "task", name: "crash-job", task: "Inspect" });
}, 120_000);
