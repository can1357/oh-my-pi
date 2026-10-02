import * as path from "node:path";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgGoalContinuationModes } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

// Real SDK session (goal tool registered as in production), RPC dispatch and goal
// runtime; only the model is scripted.
// GOAL_RPC_CONTINUATION="1" opts into `goal.continuationModes: ["rpc"]`.
// GOAL_RPC_SCRIPT="complete" (default): the first goal turn does some work and ends; only
// the next (continuation) turn completes the goal with the goal tool.
// GOAL_RPC_SCRIPT="idle": every turn replies with text only (no progress).
// GOAL_RPC_PLAN="1": the session starts in plan mode.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const settings = await Settings.init({ inMemory: true, cwd });
cfgAsyncEnabled.set(settings, false);
cfgGoalContinuationModes.set(settings, Bun.env.GOAL_RPC_CONTINUATION === "1" ? ["rpc"] : ["interactive"]);
const { session } = await createAgentSession({
	cwd,
	agentDir: cwd,
	// GOAL_RPC_PERSIST=1: a file-backed session, so /goaltest-reload really reopens it.
	sessionManager: Bun.env.GOAL_RPC_PERSIST === "1" ? SessionManager.create(cwd) : SessionManager.inMemory(cwd),
	authStorage,
	modelRegistry,
	settings,
	model: getBundledModel("anthropic", "claude-sonnet-4-5"),
	disableExtensionDiscovery: true,
	skills: [],
	contextFiles: [],
	workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
	// Extension commands that change the session (/goaltest-new-session) or navigate within it (/goaltest-navigate-here).
	extensions: [
		pi => {
			pi.registerCommand("goaltest-new-session", {
				description: "start a new session from an extension; any argument text is then sent as a prompt",
				handler: async (args, ctx) => {
					await ctx.newSession();
					if (args.trim()) pi.sendUserMessage(args.trim());
				},
			});
			pi.registerCommand("goaltest-reload", {
				description: "reload the session from disk",
				handler: async (_args, ctx) => {
					await ctx.reload();
				},
			});
			pi.registerCommand("goaltest-navigate-here", {
				description: "navigate to the current leaf (no session change)",
				handler: async (_args, ctx) => {
					const leaf = ctx.sessionManager.getLeafId();
					if (leaf) await ctx.navigateTree(leaf);
				},
			});
		},
	],
});
// GOAL_RPC_SCRIPT="slow": the first turn stalls long enough for the host to abort it.
const turns: MockResponse[] =
	Bun.env.GOAL_RPC_SCRIPT === "idle"
		? []
		: Bun.env.GOAL_RPC_SCRIPT === "slow"
			? [{ content: [{ type: "toolCall", id: "s1", name: "goal", arguments: { op: "get" } }], delayMs: 10_000 }]
			: [
					{ content: [{ type: "toolCall", id: "t1", name: "goal", arguments: { op: "get" } }] },
					{ content: ["Step one done."] },
					{ content: [{ type: "toolCall", id: "t2", name: "goal", arguments: { op: "complete" } }] },
					{ content: ["Goal complete."] },
				];
const mock = createMockModel({ handler: () => turns.shift() ?? { content: ["Nothing left to do."] } });
session.agent.streamFn = mock.stream;
if (Bun.env.GOAL_RPC_PLAN === "1") {
	session.setPlanModeState({ enabled: true, planFilePath: path.join(cwd, "plan.md") });
}
await runRpcMode(session);
