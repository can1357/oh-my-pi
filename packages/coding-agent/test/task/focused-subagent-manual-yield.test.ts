/**
 * Undriven kept-alive subagent turns: focused-user yields reach the parent
 * (#14428), and an IRC parent follow-up consumed during a peer wake replaces
 * the accepted plain result without turning peer-only replies into completions.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "FocusedYield";
const PARENT_ID = "Main";
const MOCK_API_SOURCE = "test/focused-subagent-manual-yield";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let manager: AsyncJobManager;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-focused-yield-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	manager = new AsyncJobManager({ maxRunningJobs: 4 });
	AsyncJobManager.setInstance(manager);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AsyncJobManager.setInstance(undefined);
	await manager.dispose({ timeoutMs: 1_000 });
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	// The subagent session opened agent.db and models.db under root; Windows cannot delete open files.
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

/** Result each typed prompt asks for; the spawn task and any non-user turn yield `initial result`. */
const PROMPT_RESULTS: Record<string, string> = { "go on": "manual result", "finish up": "final result" };

/** The yield data for the newest typed (user-role) prompt the mock model sees. */
function resultForLatestPrompt(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
							.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
							.join("")
					: "";
		for (const prompt in PROMPT_RESULTS) {
			if (text.includes(prompt)) return PROMPT_RESULTS[prompt];
		}
	}
	return "initial result";
}

/** Starts an idle child with an accepted result and records subsequent parent deliveries. */
async function spawnKeptAliveChild(options?: { handler?: MockHandler; structured?: boolean; enableIrc?: boolean }) {
	// Under the isolated HOME: project discovery walks up from cwd and stops at os.homedir(). On Windows
	// os.tmpdir() lives under the real home, so a cwd outside the fake HOME would walk into the real
	// ~/.omp and load the developer's installed plugins as project plugins.
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		handler:
			options?.handler ??
			(context => {
				if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
				// A turn that already yielded ends on the tool result; answer it with prose.
				if (context.messages.at(-1)?.role === "toolResult") return { content: ["ok"] };
				const data = resultForLatestPrompt(context.messages);
				return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data } }] };
			}),
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);

	const deliveries: string[] = [];
	const firstDelivery = Promise.withResolvers<string>();
	const unregisterSink = manager.registerDeliverySink(PARENT_ID, (_jobId, text) => {
		deliveries.push(text);
		firstDelivery.resolve(text);
	});
	const close = (): void => {
		unregisterSink();
		authStorage.close();
	};
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: "report",
			index: 0,
			id: AGENT_ID,
			parentAgentId: PARENT_ID,
			asyncJobManager: manager,
			structured: options?.structured,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"task.agentIdleTtlMs": 0,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: options?.enableIrc ?? false,
		});
		expect(result.exitCode).toBe(0);
	} catch (error) {
		close();
		throw error;
	}
	const artifact = path.join(artifactsDir, `${AGENT_ID}.md`);
	if (options?.structured === false) expect(await Bun.file(artifact).text()).toContain("INITIAL_FINAL");
	else expect(await Bun.file(artifact).text()).toContain("initial result");
	const session = AgentRegistry.global().get(AGENT_ID)?.session;
	if (!session) {
		close();
		throw new Error("kept-alive subagent has no live session");
	}
	return { session, artifact, deliveries, firstDelivery: firstDelivery.promise, close, mock };
}

it("a focused manual prompt's yield rewrites the artifact and notifies the parent", async () => {
	const child = await spawnKeptAliveChild();
	try {
		// The focused-session input path: a plain user prompt on the idle child.
		await child.session.prompt("go on");

		// The job settles only after finalization has rewritten the artifact.
		expect(await child.firstDelivery).toContain("manual result");
		expect(await Bun.file(child.artifact).text()).toContain("manual result");
	} finally {
		child.close();
	}
}, 15_000);

it("a prompt typed while the previous turn awaits owned background work reports each turn's own result", async () => {
	const child = await spawnKeptAliveChild();
	try {
		// Owned background work keeps the first manual turn's observation open
		// after the turn itself returns, leaving the child idle for another prompt.
		const gate = Promise.withResolvers<void>();
		manager.register(
			"bash",
			"background build",
			async () => {
				await gate.promise;
				return "build done";
			},
			{ ownerId: AGENT_ID, agentId: AGENT_ID },
		);
		await child.session.prompt("go on");
		await child.session.prompt("finish up");
		gate.resolve();

		await child.firstDelivery;
		await manager.waitForOwnerJobs(PARENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		// One completion per turn, each carrying only that turn's yield.
		const manual = child.deliveries.filter(text => text.includes("manual result"));
		const final = child.deliveries.filter(text => text.includes("final result"));
		expect(child.deliveries).toHaveLength(2);
		expect(manual).toHaveLength(1);
		expect(final).toHaveLength(1);
		expect(manual[0]).not.toContain("final result");
		expect(await Bun.file(child.artifact).text()).toContain("final result");
	} finally {
		child.close();
	}
}, 15_000);

it("publishes a consumed parent injection during a peer wake without publishing peer-only replies", async () => {
	const peerStarted = Promise.withResolvers<void>();
	const releasePeer = Promise.withResolvers<void>();
	let request = 0;
	const child = await spawnKeptAliveChild({
		structured: false,
		enableIrc: true,
		handler: async () => {
			request++;
			if (request === 1) return { content: ["INITIAL_FINAL"] };
			if (request === 2) return { content: ["POSITIVE_FINAL"] };
			if (request === 3) {
				peerStarted.resolve();
				await releasePeer.promise;
				return { content: ["PEER_INTERMEDIATE"] };
			}
			return { content: [request === 4 ? "NEGATIVE_FINAL" : "PEER_ONLY_FINAL"] };
		},
	});
	try {
		const bus = IrcBus.global();
		const positive = await bus.send({ from: PARENT_ID, to: AGENT_ID, body: "First follow-up" });
		expect(positive.outcome).toBe("woken");
		await child.session.waitForIdle();
		await child.session.waitForIrcReplies();
		await manager.waitForOwnerJobs(PARENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		expect(await Bun.file(child.artifact).text()).toContain("POSITIVE_FINAL");
		expect(child.deliveries.filter(text => text.includes("POSITIVE_FINAL"))).toHaveLength(1);
		const peer = await bus.send({ from: "Peer", to: AGENT_ID, body: "Can you check?" });
		expect(peer.outcome).toBe("woken");
		await peerStarted.promise;
		const parent = await bus.send({ from: PARENT_ID, to: AGENT_ID, body: "Publish the follow-up" });
		expect(parent.outcome).toBe("injected");
		// Receiving the request is not consumption; the prior result is still authoritative.
		expect(await Bun.file(child.artifact).text()).toContain("POSITIVE_FINAL");
		expect(child.deliveries).toHaveLength(1);
		expect(manager.getAllJobs({ ownerId: PARENT_ID })).toHaveLength(1);
		releasePeer.resolve();
		await child.session.waitForIdle();
		await child.session.waitForIrcReplies();
		await manager.waitForOwnerJobs(PARENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		expect(JSON.stringify(child.mock.calls.at(-1)?.context.messages)).toContain("Publish the follow-up");
		expect(await Bun.file(child.artifact).text()).toContain("NEGATIVE_FINAL");
		expect(child.deliveries.filter(text => text.includes("NEGATIVE_FINAL"))).toHaveLength(1);
		expect(
			manager.getAllJobs({ ownerId: PARENT_ID }).filter(job => job.resultText?.includes("NEGATIVE_FINAL")),
		).toHaveLength(1);
		const peerOnly = await bus.send({ from: "Peer", to: AGENT_ID, body: "One more check?" });
		expect(peerOnly.outcome).toBe("woken");
		await child.session.waitForIdle();
		await child.session.waitForIrcReplies();
		await manager.waitForOwnerJobs(PARENT_ID);
		expect(await Bun.file(child.artifact).text()).toContain("NEGATIVE_FINAL");
		expect(child.deliveries).toHaveLength(2);
		expect(manager.getAllJobs({ ownerId: PARENT_ID })).toHaveLength(2);
	} finally {
		releasePeer.resolve();
		child.close();
	}
}, 15_000);
