import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const cwd = process.cwd();
const source = Bun.env.GOAL_COMMAND_SOURCE ?? "extension";
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const sessionManager = SessionManager.inMemory(cwd);
const runtime = new ExtensionRuntime();
const extension = await loadExtensionFromFactory(
	pi => {
		for (const name of source === "extension" ? ["goal", "guided-goal"] : []) {
			pi.registerCommand(name, {
				description: `User ${name}`,
				handler: async args => {
					pi.sendUserMessage(`user-command:${name}:${args}`);
				},
			});
		}
	},
	cwd,
	new EventBus(),
	runtime,
	"goal-command-collision",
);
const extensionRunner = new ExtensionRunner([extension], runtime, cwd, sessionManager, modelRegistry);
const mock = createMockModel({ handler: { content: ["ok"] } });
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
	extensionRunner,
	customCommands:
		source === "custom"
			? ["goal", "guided-goal"].map(name => ({
					path: path.join(cwd, `${name}.ts`),
					resolvedPath: path.join(cwd, `${name}.ts`),
					source: "project" as const,
					command: {
						name,
						description: `User ${name}`,
						execute: (args: string[]) => `user-command:${name}:${args.join(" ")}`,
					},
				}))
			: [],
});
await runRpcMode(session);
