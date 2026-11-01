/**
 * A subagent is routable for IRC as soon as its session attaches to the registry, before the
 * executor finishes startup and dispatches the assignment. A message that lands in that window
 * must not start a turn the assignment never reaches (#17587).
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "EarlyIrc";
const IRC_BODY = "which files do you own?";
const ASSIGNMENT = "Target: src/gate.ts. Change: add the ownership gate.";
const MOCK_API_SOURCE = "test/subagent-irc-before-assignment";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-irc-before-assignment-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

it.each([
	{ label: "the parent", from: MAIN_AGENT_ID, ownTurn: false },
	{ label: "a peer", from: "SiblingScout", ownTurn: true },
])(
	"delivers the assignment when $label messages the subagent during startup",
	async ({ from, ownTurn }) => {
		const cwd = path.join(root, "home", "work");
		const artifactsDir = path.join(root, "artifacts");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(artifactsDir, { recursive: true });

		// `session_start` runs after the session is IRC-routable and before the assignment dispatches;
		// a slow extension start widens that window the way a slow MCP/plugin start does.
		const startup = Promise.withResolvers<void>();
		const startupEntered = Promise.withResolvers<void>();
		const slowStart: ExtensionFactory = pi => {
			pi.on("session_start", async () => {
				startupEntered.resolve();
				await startup.promise;
			});
		};

		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const requests: Array<{ assignment: boolean; irc: boolean }> = [];
		const ircSeen = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: context => {
				// Everything the model was sent besides its own turns.
				const sent = context.messages
					.filter(message => message.role !== "assistant")
					.map(message => JSON.stringify(message.content))
					.join("\n");
				const request = { assignment: sent.includes(ASSIGNMENT), irc: sent.includes(IRC_BODY) };
				requests.push(request);
				if (request.irc) ircSeen.resolve();
				if (!request.assignment) return { content: ["Context arrived without a task."] };
				if (requests.length > 1) return { content: ["src/gate.ts"] };
				return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
			},
		});
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
		const settings = Settings.isolated({
			"task.agentIdleTtlMs": 0,
			"async.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			modelRoles: { default: "mock/mock-model" },
		});

		try {
			const running = runSubprocess({
				cwd,
				artifactsDir,
				agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
				task: ASSIGNMENT,
				index: 0,
				id: AGENT_ID,
				modelOverride: "mock/mock-model",
				parentAgentId: MAIN_AGENT_ID,
				authStorage,
				modelRegistry,
				preloadedPreparedExtensions: [
					{ path: "<inline-0>", resolvedPath: "<inline-0>", factory: slowStart, error: null },
				],
				settings,
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			});
			await startupEntered.promise;
			const session = AgentRegistry.global().get(AGENT_ID)?.session;
			if (!session) throw new Error(`${AGENT_ID} is not routable during startup`);
			await session.deliverIrcMessage({ id: "early", from, to: AGENT_ID, body: IRC_BODY, ts: 1 });
			startup.resolve();

			const result = await running;
			expect(result.exitCode).toBe(0);
			await ircSeen.promise;
			await session.waitForIdle();
			// Every turn sees the assignment. The parent's message rides the assignment's turn; a peer's
			// waits for a turn of its own after the run, whose result must not answer the peer.
			expect(requests.every(request => request.assignment)).toBe(true);
			expect(requests[0]!.irc).toBe(!ownTurn);
		} finally {
			authStorage.close();
		}
	},
	30_000,
);
