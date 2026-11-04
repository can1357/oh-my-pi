import { expect, onTestFinished, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { __resetDirsFromEnvForTests, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AgentStorage } from "../../src/session/agent-storage";
import { SessionManager } from "../../src/session/session-manager";
import { createPersistedSubagentReviverFactory } from "../../src/task/persisted-revive";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import { setSubagentWorkerPoolForTests, SubagentWorkerPool } from "../../src/thread/subagent-worker";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const RESPONSE =
	'data: {"id":"held","object":"chat.completion.chunk","created":0,"model":"local","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: {"id":"held","object":"chat.completion.chunk","created":0,"model":"local","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

async function fixture() {
	const temp = TempDir.createSync("omp-worker-holds-");
	const envKeys = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
	const savedEnv = envKeys.map(key => [key, process.env[key]] as const);
	const cleanups: Array<() => void | Promise<void>> = [];
	onTestFinished(async () => {
		try {
			await AgentLifecycleManager.global().dispose();
			for (const cleanup of cleanups.reverse()) await cleanup();
		} finally {
			setSubagentWorkerPoolForTests(undefined);
			AgentStorage.close();
			closeModelCache();
			AgentRegistry.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
			for (const [key, value] of savedEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			__resetDirsFromEnvForTests();
			await temp.remove();
		}
	});
	const cwd = temp.join("work");
	const agentDir = temp.join("home", ".omp", "agent");
	await fs.mkdir(cwd, { recursive: true });
	process.env.HOME = temp.join("home");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.OMP_PROFILE;
	delete process.env.PI_PROFILE;
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: request => {
			requests.push(new URL(request.url).pathname);
			return new Response(RESPONSE, { headers: { "content-type": "text/event-stream" } });
		},
	});
	cleanups.push(() => server.stop(true));
	const auth = createInMemoryAuthStorage();
	cleanups.push(() => auth.close());
	const modelsPath = path.join(agentDir, "models.yml");
	await Bun.write(
		modelsPath,
		`providers:\n  local:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: local\n        name: Local\n        reasoning: false\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n`,
	);
	const models = new ModelRegistry(auth, modelsPath);
	await models.refresh();
	const model = models.find("local", "local");
	if (!model) throw new Error("Missing local model");
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.completionProbe": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"advisor.enabled": false,
		modelRoles: { default: "local/local" },
	});
	const root = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["root"], tools: [] } }),
		sessionManager: SessionManager.inMemory(cwd),
		modelRegistry: models,
		settings,
		agentId: "Main",
	});
	cleanups.push(() => root.dispose());
	const pool = new SubagentWorkerPool({
		maxWorkers: () => 1,
		hostsOnMain: false,
		idleMs: 600_000,
		worker: { initTimeoutMs: 60_000 },
	});
	cleanups.push(() => pool.dispose());
	setSubagentWorkerPoolForTests(pool);
	const seed = SessionManager.create(cwd, temp.join("sessions"));
	cleanups.push(() => seed.close());
	seed.appendSessionInit({
		systemPrompt: ["revived child"],
		task: "revive",
		tools: [],
		restrictToolNames: true,
		resolvedModel: "local/local",
	});
	seed.appendMessage({ role: "user", content: "seed", timestamp: 0 });
	await seed.ensureOnDisk();
	await seed.flush();
	const sessionFile = seed.getSessionFile();
	await seed.close();
	if (!sessionFile) throw new Error("Missing child transcript");
	const ref = AgentRegistry.global().register({
		id: "WorkerChild",
		displayName: "WorkerChild",
		kind: "sub",
		parentId: "Main",
		sessionFile,
		session: null,
		status: "parked",
	});
	const factory = createPersistedSubagentReviverFactory({
		session: root,
		authStorage: auth,
		modelRegistry: models,
		settings,
		enableLsp: false,
	});
	const revive = await factory(ref);
	if (!revive) throw new Error("Missing reviver");
	const child = await revive(ref);
	if (!(child instanceof RemoteAgentSession)) throw new Error("Expected real worker-homed child");
	expect(pool.forThread(child.home)?.alive).toBe(true);
	return { root, child, model, requests };
}

test("a worker-homed cold-revived child sends once only after its main-thread root releases", async () => {
	const { root, child, requests } = await fixture();
	let held = true;
	const checked = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const remove = root.agent.addHold(() => ({
		pending: () => {
			checked.resolve();
			return held ? released.promise : undefined;
		},
	}));
	const run = child.prompt("revived worker work");
	try {
		await Promise.race([checked.promise, run]);
		expect(requests).toEqual([]);
		held = false;
		released.resolve();
		await run;
		expect(requests).toEqual(["/v1/chat/completions"]);
	} finally {
		held = false;
		released.resolve();
		remove();
		await run;
		await child.dispose();
	}
}, 120_000);

test("a failed main-thread root hold reaches the revived worker without sending", async () => {
	const { root, child, requests } = await fixture();
	const checked = Promise.withResolvers<void>();
	const blocked = Promise.withResolvers<void>();
	const remove = root.agent.addHold(() => ({
		pending: () => {
			checked.resolve();
			return blocked.promise;
		},
	}));
	const run = child.prompt("failed hold");
	try {
		await Promise.race([checked.promise, run]);
		expect(requests).toEqual([]);
		blocked.reject(new Error("root hold failed on main"));
		await run;
		const message = child.messages.at(-1);
		if (message?.role !== "assistant") throw new Error("Missing worker error message");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("root hold failed on main");
		expect(requests).toEqual([]);
	} finally {
		blocked.resolve();
		remove();
		await run;
		await child.dispose();
	}
}, 120_000);

test("main-thread work entered through a remote session waits and rechecks on its next request", async () => {
	const { root, child, model, requests } = await fixture();
	let checked = Promise.withResolvers<void>();
	let released = Promise.withResolvers<void>();
	let held = true;
	const remove = root.agent.addHold(() => ({
		pending: () => {
			checked.resolve();
			return held ? released.promise : undefined;
		},
	}));
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			checked = Promise.withResolvers<void>();
			released = Promise.withResolvers<void>();
			held = true;
			const run = child.runInRequestContext(() =>
				completeSimple(
					model,
					{ messages: [{ role: "user", content: "remote context", timestamp: 0 }] },
					{ apiKey: "test" },
				),
			);
			try {
				await Promise.race([checked.promise, run]);
				expect(requests).toHaveLength(attempt);
				held = false;
				released.resolve();
				await run;
				expect(requests).toHaveLength(attempt + 1);
			} finally {
				held = false;
				released.resolve();
				await run;
			}
		}
	} finally {
		remove();
		await child.dispose();
	}
}, 120_000);

test("aborting remote-context work releases its home-thread hold view without sending", async () => {
	const { root, child, model, requests } = await fixture();
	const checked = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const blocked = Promise.withResolvers<void>();
	const remove = root.agent.addHold(() => ({
		pending: () => {
			checked.resolve();
			return blocked.promise;
		},
		release: released.resolve,
	}));
	const controller = new AbortController();
	const run = child.runInRequestContext(() =>
		completeSimple(
			model,
			{ messages: [{ role: "user", content: "abort remote context", timestamp: 0 }] },
			{ apiKey: "test", signal: controller.signal },
		),
	);
	try {
		await Promise.race([checked.promise, run]);
		expect(requests).toEqual([]);
		controller.abort();
		const result = await run;
		expect(result.stopReason).toBe("aborted");
		await released.promise;
		expect(requests).toEqual([]);
	} finally {
		controller.abort();
		blocked.resolve();
		remove();
		await run;
		await child.dispose();
	}
}, 120_000);
