import { afterEach, expect, it, vi } from "bun:test";
import type { Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import type { TerminalLaunchRequest } from "@oh-my-pi/pi-coding-agent/subprocess/terminal-launch";
import { TempDir } from "@oh-my-pi/pi-utils";

const muse = getBundledModel("muse-code", "muse-spark-1.3-contributor");
const luna = getBundledModel("openai-codex", "gpt-6-luna");

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

async function fixture() {
	const dir = TempDir.createSync("@omp-task-cache-forks-");
	const auth = await AuthStorage.create(dir.join("auth.db"));
	auth.keys.setRuntime("muse-code", "test-key");
	auth.keys.setRuntime("openai-codex", "test-key");
	const sessions: AgentSession[] = [];
	const requests: Array<{
		key: unknown;
		sessionId: string | undefined;
		state: Map<string, ProviderSessionState> | undefined;
	}> = [];
	const mock = createMockModel({ handler: { content: [{ type: "text", text: "Review complete." }] } });
	const realStreamFactory = settingsStream.createSettingsAwareStreamFn;
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slow) =>
		realStreamFactory(
			settings,
			async (model, context, options) => {
				const cacheOptions = {
					sessionId: options?.sessionId,
					promptCacheKey: options?.promptCacheKey,
					providerSessionState: options?.providerSessionState,
				};
				const body =
					model.api === "openai-codex-responses"
						? await buildTransformedCodexRequestBody(
								model as Model<"openai-codex-responses">,
								context,
								cacheOptions,
							)
						: buildParams(model as Model<"openai-responses">, context, cacheOptions, undefined).params;
				requests.push({
					key: body.prompt_cache_key,
					sessionId: options?.sessionId,
					state: options?.providerSessionState,
				});
				return mock.stream(model, context, options);
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
	const common: sdk.CreateAgentSessionOptions = {
		cwd: dir.path(),
		agentDir: dir.path(),
		authStorage: auth,
		model: muse,
		settings,
		systemPrompt: ["Review the supplied code."],
		toolNames: [],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
	};
	async function create(options: sdk.CreateAgentSessionOptions = {}) {
		const { session } = await sdk.createAgentSession({ ...common, ...options });
		sessions.push(session);
		return session;
	}
	async function request(session: AgentSession, model: Model, key: string | undefined) {
		await session.setModel(model);
		await session.prompt("Continue the code review.");
		expect(requests.at(-1)?.key).toBe(key ?? session.agent.sessionId);
	}
	function context(session: AgentSession): InteractiveModeContext {
		return {
			session,
			sessionManager: session.sessionManager,
			settings,
			showError: (message: string) => {
				throw new Error(message);
			},
			showWarning: () => {},
			showStatus: () => {},
			showHookConfirm: async () => true,
			rebuildChatFromMessages: () => {},
		} as unknown as InteractiveModeContext;
	}
	return {
		dir,
		sessions,
		requests,
		create,
		request,
		context,
		async [Symbol.asyncDispose]() {
			await Promise.all(sessions.map(session => session.dispose()));
			auth.close();
			dir[Symbol.dispose]();
		},
	};
}

async function persistedHeader(manager: SessionManager): Promise<SessionHeader> {
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a persisted session");
	const records = Bun.JSONL.parse(await Bun.file(file).text()) as Array<{ type: string }>;
	const header = records.find(record => record.type === "session");
	if (!header) throw new Error("Missing session header");
	return header as SessionHeader;
}

it.each([false, true])(
	"preserves automatic versus explicit routing through live and terminal forks (explicit=%s)",
	async explicit => {
		await using h = await fixture();
		const manager = SessionManager.create(h.dir.path(), h.dir.join("parent"));
		const parent = await h.create({
			sessionManager: manager,
			taskPromptCacheKey: "parent:task",
			providerPromptCacheKey: explicit ? "explicit-cache" : undefined,
		});
		await h.request(parent, muse, explicit ? "explicit-cache" : "parent:task");
		const before = h.requests.at(-1)!;
		const launches: TerminalLaunchRequest[] = [];
		const controller = new CommandController(h.context(parent), {
			environment: () => ({ TMUX: "server,1,0", TMUX_PANE: "%1" }),
			resolveCliEntryCmd: () => ["omp-entry"],
			getActiveProfile: () => undefined,
			argv: () => [],
			launchTerminal: async request => {
				launches.push(request);
				return { multiplexer: request.multiplexer, placement: request.placement };
			},
		});
		await controller.handleForkCommand("pane");
		expect(launches).toHaveLength(1);
		const command = launches[0]!.command;
		const parsed = parseArgs(command.slice(command.indexOf("omp-entry") + 1));
		expect(parsed.providerPromptCacheKey).toBe(explicit ? "explicit-cache" : undefined);
		const childManager = await SessionManager.forkFrom(
			manager.getSessionFile()!,
			h.dir.path(),
			h.dir.join("terminal"),
		);
		const child = await h.create({
			sessionManager: childManager,
			providerPromptCacheKey: parsed.providerPromptCacheKey,
		});
		await h.request(child, muse, explicit ? "explicit-cache" : "parent:task");
		expect(h.requests.at(-1)?.sessionId).not.toBe(before.sessionId);
		expect(h.requests.at(-1)?.state).not.toBe(before.state);
		await h.request(child, luna, explicit ? "explicit-cache" : undefined);
		await h.request(child, muse, explicit ? "explicit-cache" : "parent:task");
		expect(await parent.fork(undefined, { requireIdle: true })).toBe(true);
		await h.request(parent, muse, explicit ? "explicit-cache" : "parent:task");
		expect(h.requests.at(-1)?.sessionId).not.toBe(before.sessionId);
		await h.request(parent, luna, explicit ? "explicit-cache" : undefined);
		await h.request(parent, muse, explicit ? "explicit-cache" : "parent:task");
		for (const current of [manager, childManager]) {
			const header = await persistedHeader(current);
			expect(header.taskPromptCacheKey).toBe("parent:task");
			expect(header.providerPromptCacheKey).toBeUndefined();
		}
	},
);

it.each([false, true])("keeps tan's copied candidate model-gated (explicit=%s)", async explicit => {
	await using h = await fixture();
	const parent = await h.create({
		sessionManager: SessionManager.create(h.dir.path(), h.dir.join("parent")),
		taskPromptCacheKey: "parent:task",
		providerPromptCacheKey: explicit ? "explicit-cache" : undefined,
	});
	await h.request(parent, muse, explicit ? "explicit-cache" : "parent:task");
	const parentRequest = h.requests.at(-1)!;
	const realCreate = sdk.createAgentSession;
	vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
		const created = await realCreate(options);
		h.sessions.push(created.session);
		await h.request(created.session, muse, explicit ? "explicit-cache" : "parent:task");
		expect(h.requests.at(-1)?.sessionId).not.toBe(parentRequest.sessionId);
		expect(h.requests.at(-1)?.state).not.toBe(parentRequest.state);
		await h.request(created.session, luna, explicit ? "explicit-cache" : undefined);
		await h.request(created.session, muse, explicit ? "explicit-cache" : "parent:task");
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
	await new TanCommandController(h.context(parent)).start("Review another file");
	if (!runJob) throw new Error("Tan did not register its job");
	await runJob();
	expect(h.requests).toHaveLength(5);
});

it("restores automatic affinity from disk without promoting a legacy fork fallback", async () => {
	await using h = await fixture();
	const manager = SessionManager.create(h.dir.path(), h.dir.join("parent"));
	const seed = await h.create({ sessionManager: manager });
	await h.request(seed, muse, undefined);
	await seed.fork();
	const inherited = manager.getHeader()?.providerPromptCacheKey;
	expect(inherited).toBeDefined();
	await seed.dispose();
	const reopened = await SessionManager.open(manager.getSessionFile()!, h.dir.path());
	const seeded = await h.create({
		sessionManager: reopened,
		taskPromptCacheKey: "restored:task",
		providerPromptCacheKey: inherited,
		providerPromptCacheKeySource: "fork",
	});
	await h.request(seeded, muse, "restored:task");
	expect((await persistedHeader(reopened)).providerPromptCacheKey).toBeUndefined();
	await seeded.dispose();
	const restored = await h.create({
		sessionManager: await SessionManager.open(reopened.getSessionFile()!, h.dir.path()),
	});
	await h.request(restored, muse, "restored:task");
	await h.request(restored, luna, undefined);
	await h.request(restored, muse, "restored:task");
	await restored.dispose();
	const overridden = await h.create({
		sessionManager: await SessionManager.open(reopened.getSessionFile()!, h.dir.path()),
		providerPromptCacheKey: "caller-override",
	});
	await h.request(overridden, muse, "caller-override");
	await h.request(overridden, luna, "caller-override");
});

it("clears automatic affinity on new and partial sessions and restores the destination on switch", async () => {
	await using h = await fixture();
	const session = await h.create({
		sessionManager: SessionManager.create(h.dir.path(), h.dir.join("parent")),
		taskPromptCacheKey: "parent:task",
	});
	await h.request(session, muse, "parent:task");
	const originalFile = session.sessionManager.getSessionFile()!;
	expect(await session.newSession()).toBe(true);
	await h.request(session, muse, undefined);
	expect(await session.switchSession(originalFile)).toBe(true);
	await h.request(session, muse, "parent:task");
	const leaf = session.sessionManager.getBranch().find(entry => entry.type === "message");
	if (!leaf) throw new Error("Missing message to fork");
	expect(await session.fork(leaf.id)).toBe(true);
	await h.request(session, muse, undefined);
	expect((await persistedHeader(session.sessionManager)).taskPromptCacheKey).toBeUndefined();
});
