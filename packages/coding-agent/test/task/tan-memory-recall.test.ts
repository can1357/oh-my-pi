/**
 * `/tan` copies the parent's system prompt, which already carries the parent's
 * first-turn memory recall. The clone must send that prompt as-is: recalling
 * again would append the same memories as an extra block, duplicating them and
 * breaking the prompt-cache prefix the clone shares with its parent.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
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
const MEMORY = "The deploy host is alpha-7.";

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

it("sends the parent's recalled system prompt unchanged from a /tan clone", async () => {
	using dir = TempDir.createSync("@omp-tan-memory-recall-");
	const auth = await AuthStorage.create(dir.join("auth.db"));
	auth.keys.setRuntime("muse-code", "test-key");
	const sessions: AgentSession[] = [];
	const systemPrompts: string[][] = [];
	const mock = createMockModel({ handler: { content: [{ type: "text", text: "alpha-7" }] } });
	const realStreamFactory = settingsStream.createSettingsAwareStreamFn;
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slow) =>
		realStreamFactory(
			settings,
			(streamModel, context, options) => {
				systemPrompts.push([...(context.systemPrompt ?? [])]);
				return mock.stream(streamModel, context, options);
			},
			slow,
		),
	);
	// Sessions start Mnemopi in the background: [parent, clone] settle as each start finishes.
	const mnemopiStarts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const realStart = mnemopiBackend.start;
	let startCount = 0;
	vi.spyOn(mnemopiBackend, "start").mockImplementation(async options => {
		await realStart.call(mnemopiBackend, options);
		mnemopiStarts[startCount++]?.resolve();
	});
	const settings = Settings.isolated({
		"async.enabled": true,
		"marketplace.autoUpdate": "off",
		"compaction.enabled": false,
		"task.enableLsp": false,
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": dir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
		"mnemopi.autoRetain": false,
	});
	try {
		const { session: parent } = await sdk.createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage: auth,
			model,
			settings,
			sessionManager: SessionManager.create(dir.path(), dir.join("parent")),
			toolNames: [],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(parent);
		await mnemopiStarts[0]!.promise;
		getMnemopiSessionState(parent)!.rememberScoped(MEMORY);
		await parent.prompt("Where is the deploy host?");
		await parent.prompt("And which host serves staging?");
		const parentPrompt = systemPrompts.at(-1)!;
		expect(parentPrompt.join("\n").split(MEMORY)).toHaveLength(2);

		const realCreate = sdk.createAgentSession;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const created = await realCreate(options);
			sessions.push(created.session);
			await mnemopiStarts[1]!.promise;
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
		const requestsBeforeClone = systemPrompts.length;
		await runJob();

		const clonePrompt = systemPrompts[requestsBeforeClone];
		expect(clonePrompt).toEqual(parentPrompt);
	} finally {
		await Promise.all(sessions.map(session => session.dispose()));
		auth.close();
	}
});
