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
// GOAL_RPC_SCRIPT="slow": the first turn stalls until the host aborts it or runs /goaltest-release.
// GOAL_RPC_PLAN="1": the session starts in plan mode.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const settings = await Settings.init({ inMemory: true, cwd });
cfgAsyncEnabled.set(settings, false);
cfgGoalContinuationModes.set(settings, Bun.env.GOAL_RPC_CONTINUATION === "1" ? ["rpc"] : ["interactive"]);
const slowTurnRelease = Promise.withResolvers<void>();
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
	// Extension commands that change the session (/goaltest-new-session), navigate within it (/goaltest-navigate-here),
	// or end the "slow" script's stalled turn (/goaltest-release).
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
			pi.registerCommand("goaltest-release", {
				description: "let the stalled first turn of the slow script finish",
				handler: async () => {
					slowTurnRelease.resolve();
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
const turns: MockResponse[] =
	Bun.env.GOAL_RPC_SCRIPT === "complete" || Bun.env.GOAL_RPC_SCRIPT === undefined
		? [
				{ content: [{ type: "toolCall", id: "t1", name: "goal", arguments: { op: "get" } }] },
				{ content: ["Step one done."] },
				{ content: [{ type: "toolCall", id: "t2", name: "goal", arguments: { op: "complete" } }] },
				{ content: ["Goal complete."] },
			]
		: [];
let slowTurnPending = Bun.env.GOAL_RPC_SCRIPT === "slow";
const mock = createMockModel({
	handler: async (_context, options) => {
		if (!slowTurnPending) return turns.shift() ?? { content: ["Nothing left to do."] };
		slowTurnPending = false;
		const signal = options?.signal;
		const stalled = Promise.withResolvers<void>();
		void slowTurnRelease.promise.then(stalled.resolve);
		if (signal?.aborted) stalled.resolve();
		else signal?.addEventListener("abort", () => stalled.resolve(), { once: true });
		await stalled.promise;
		// An aborted stall ends through the mock's delay path, which reports a delay under an aborted signal as an aborted request.
		return {
			content: [{ type: "toolCall", id: "s1", name: "goal", arguments: { op: "get" } }],
			...(signal?.aborted ? { delayMs: 1 } : {}),
		};
	},
});
session.agent.streamFn = mock.stream;
if (Bun.env.GOAL_RPC_PLAN === "1") {
	session.setPlanModeState({ enabled: true, planFilePath: path.join(cwd, "plan.md") });
}
await runRpcMode(session);
