/**
 * A vibe-mode parent advertises `read todo vibe_*`, with `edit` registered but
 * inactive. Its `/tan` clone must send the same tool schemas so its first
 * request reuses the parent's prompt cache, without being able to spawn or
 * drive vibe workers itself.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { TempDir } from "@oh-my-pi/pi-utils";

const model = getBundledModel("muse-code", "muse-spark-1.3-contributor");

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

it("sends a vibe-mode parent's tool schemas from its /tan clone, whose vibe calls fail", async () => {
	using dir = TempDir.createSync("@omp-tan-vibe-tools-");
	const auth = await AuthStorage.create(dir.join("auth.db"));
	auth.keys.setRuntime("muse-code", "test-key");
	const sessions: AgentSession[] = [];
	const requestTools: Array<Array<{ name: string; description: string; parameters: unknown }>> = [];
	const mock = createMockModel({ handler: { content: [{ type: "text", text: "Done." }] } });
	const realStreamFactory = settingsStream.createSettingsAwareStreamFn;
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slow) =>
		realStreamFactory(
			settings,
			(streamModel, context, options) => {
				requestTools.push(
					(context.tools ?? []).map(({ name, description, parameters }) => ({ name, description, parameters })),
				);
				return mock.stream(streamModel, context, options);
			},
			slow,
		),
	);
	const settings = Settings.isolated({
		"async.enabled": true,
		"marketplace.autoUpdate": "off",
		"compaction.enabled": false,
		"task.enableLsp": false,
	});
	try {
		const { session: parent } = await sdk.createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage: auth,
			model,
			settings,
			hasUI: true,
			sessionManager: SessionManager.create(dir.path(), dir.join("parent")),
			disableExtensionDiscovery: true,
			skipPythonPreflight: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(parent);
		await parent.activateVibeTools(["read", "todo"]);
		await parent.prompt("Direct the workers.");
		const parentTools = requestTools.at(-1)!;
		expect(parentTools.map(tool => tool.name)).toEqual([
			"read",
			"todo",
			"vibe_spawn",
			"vibe_send",
			"vibe_wait",
			"vibe_kill",
			"vibe_list",
		]);

		let clone: AgentSession | undefined;
		const realCreate = sdk.createAgentSession;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const created = await realCreate(options);
			sessions.push(created.session);
			clone = created.session;
			return created;
		});
		const manager = parent.asyncJobManager;
		if (!manager) throw new Error("Missing async job manager");
		let runJob: (() => Promise<unknown>) | undefined;
		vi.spyOn(manager, "register").mockImplementation((_type, _label, run) => {
			runJob = () =>
				run({
					jobId: "tan-test",
					signal: new AbortController().signal,
					reportProgress: async () => {},
					markRunning: () => {},
				});
			return "tan-test";
		});
		const context = {
			session: parent,
			sessionManager: parent.sessionManager,
			showHookConfirm: async () => true,
			rebuildChatFromMessages: () => {},
			settings,
			showError: (message: string) => {
				throw new Error(message);
			},
			showWarning: () => {},
			showStatus: () => {},
		} as unknown as InteractiveModeContext;
		await new TanCommandController(context).start("Check the deploy host");
		if (!runJob) throw new Error("Tan did not register its job");
		const requestsBeforeClone = requestTools.length;
		await runJob();

		expect(requestTools[requestsBeforeClone]).toEqual(parentTools);
		const spawn = clone?.getToolByName("vibe_spawn");
		if (!spawn) throw new Error("The clone did not register vibe_spawn");
		await expect(spawn.execute("vibe-fixture", { cli: "fast", prompt: "work" })).rejects.toThrow(
			"Vibe tools are unavailable in a /tan clone",
		);
	} finally {
		await Promise.all(sessions.map(session => session.dispose()));
		auth.close();
	}
}, 30_000);
