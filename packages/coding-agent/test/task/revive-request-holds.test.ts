import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { createPersistedSubagentReviverFactory } from "../../src/task/persisted-revive";

const RESPONSE =
	'data: {"id":"held","object":"chat.completion.chunk","created":0,"model":"local","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: {"id":"held","object":"chat.completion.chunk","created":0,"model":"local","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

test("a cold-revived grandchild waits for its live intermediate parent's hold", async () => {
	const temp = TempDir.createSync("omp-grandchild-holds-");
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: request => {
			requests.push(new URL(request.url).pathname);
			return new Response(RESPONSE, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("openai", "test");
	const models = new ModelRegistry(auth, temp.join("models.yml"));
	models.registerProvider("openai", {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		apiKey: "test",
		api: "openai-completions",
		models: [
			{
				id: "local",
				name: "Local",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16000,
				maxTokens: 1024,
			},
		],
	});
	const model = models.find("openai", "local");
	if (!model) throw new Error("Missing local model");
	const settings = Settings.isolated({
		"advisor.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		modelRoles: { default: "openai/local" },
	});
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	const makeSession = (id: string) =>
		new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: [id], tools: [] }, getApiKey: () => "test" }),
			sessionManager: SessionManager.inMemory(temp.path()),
			modelRegistry: models,
			settings,
			agentId: id,
		});
	const root = makeSession("Main");
	const middle = makeSession("Middle");
	AgentRegistry.global().register({
		id: "Middle",
		displayName: "Middle",
		kind: "sub",
		parentId: "Main",
		session: middle,
		status: "idle",
	});
	const seed = SessionManager.create(temp.path(), temp.join("sessions"));
	let child: AgentSession | undefined;
	let run: Promise<boolean> | undefined;
	let held = true;
	const checked = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const remove = middle.agent.addHold(() => ({
		pending: () => {
			checked.resolve();
			return held ? released.promise : undefined;
		},
	}));
	try {
		seed.appendSessionInit({
			systemPrompt: ["child"],
			task: "revive",
			tools: [],
			restrictToolNames: true,
			resolvedModel: "openai/local",
		});
		seed.appendMessage({ role: "user", content: "seed", timestamp: 0 });
		await seed.ensureOnDisk();
		await seed.flush();
		const sessionFile = seed.getSessionFile();
		await seed.close();
		if (!sessionFile) throw new Error("Missing child transcript");
		const ref = AgentRegistry.global().register({
			id: "ReviveChild",
			displayName: "ReviveChild",
			kind: "sub",
			parentId: "Middle",
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
		const revived = await revive(ref);
		if (!(revived instanceof AgentSession)) throw new Error("Expected local revived session");
		child = revived;
		run = child.prompt("revived work");
		// Either the actual hold is reached or the erroneous request completes; no timing guess.
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
		await child?.dispose();
		await seed.close();
		await middle.dispose();
		await root.dispose();
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		auth.close();
		server.stop(true);
		await temp.remove();
	}
}, 60_000);
