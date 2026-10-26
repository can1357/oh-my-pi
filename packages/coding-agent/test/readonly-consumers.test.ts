import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { cfgTaskMaxRecursionDepth } from "@oh-my-pi/pi-coding-agent/task/settings";

const realCreateAgentSession = sdk.createAgentSession;
let cwd: string;
let registry: ModelRegistry;
const sessions: AgentSession[] = [];

function settings(xdev = false): Settings {
	return Settings.isolated({ "tools.xdev": xdev, "plan.enabled": false });
}

function options(extra: Partial<CreateAgentSessionOptions> = {}): CreateAgentSessionOptions {
	return {
		cwd,
		agentDir: cwd,
		modelRegistry: registry,
		model: getBundledModel("openai", "gpt-4o-mini"),
		getApiKey: async () => "consumer-test-key",
		settings: settings(),
		sessionManager: SessionManager.inMemory(),
		bindProcessState: false,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		...extra,
	};
}

async function create(extra: Partial<CreateAgentSessionOptions> = {}): Promise<AgentSession> {
	const result = await realCreateAgentSession(options(extra));
	sessions.push(result.session);
	return result.session;
}

async function recipient(): Promise<AgentSession> {
	const session = await create({ agentId: "ConsumerRecipient", toolNames: ["read"] });
	// Real idle delivery without a provider wake: plan mode records incoming IRC in
	// the recipient's real agent state and transcript.
	session.setPlanModeState({ enabled: true, planFilePath: path.join(cwd, "plan.md") });
	return session;
}

function incoming(session: AgentSession): string[] {
	return session.messages.flatMap(message =>
		message.role === "custom" && message.customType === "irc:incoming"
			? [String(message.details?.message)]
			: [],
	);
}

async function reply(session: AgentSession, target: AgentSession, body: string): Promise<void> {
	const write = session.getToolByName("write");
	expect(write).toBeDefined();
	const result = await write!.execute(`reply-${body}`, { path: "agent://ConsumerRecipient", content: body });
	expect(result.isError).not.toBe(true);
	expect(incoming(target)).toContain(body);
}

async function denyDisk(session: AgentSession, name: string): Promise<void> {
	const target = path.join(cwd, name);
	await expect(session.getToolByName("write")!.execute(name, { path: target, content: "must not land" })).rejects.toThrow(
		/agent:\/\/ messages|Other filesystem paths are refused/,
	);
	expect(await Bun.file(target).exists()).toBe(false);
}

beforeEach(async () => {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-readonly-consumers-"));
	registry = new ModelRegistry(await sdk.discoverAuthStorage(path.join(cwd, "auth")));
	registry.authStorage.keys.setRuntime("openai", "consumer-test-key");
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0).reverse()) await session.dispose();
	registry.authStorage.close();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("readonly native transport real consumers", () => {
	it("disables the actual agent route at depth zero while preserving mounted xd dispatch, then restores replies", async () => {
		const target = await recipient();
		const state = settings(true);
		cfgTaskMaxRecursionDepth.set(state, 2);
		let deviceCalls = 0;
		const device: ExtensionFactory = pi => {
			pi.registerTool({
				name: "readonly_probe",
				label: "Probe",
				description: "Read-only mounted probe",
				parameters: type({}),
				async execute() {
					deviceCalls++;
					return { content: [{ type: "text", text: "device reached" }] };
				},
			});
		};
		const session = await create({ agentId: "LiveReadonly", settings: state, toolNames: ["read", "grep"], extensions: [device] });
		await reply(session, target, "before-disable");
		await session.setActiveToolsByName(["read", "grep", "readonly_probe"]);
		await session.refreshMCPTools([]);
		await reply(session, target, "after-ordinary-reconcile");
		await denyDisk(session, "ordinary.txt");
		cfgTaskMaxRecursionDepth.set(state, 0);
		await session.reconcileBuiltinTools({ refreshPrompt: false });
		expect(session.getActiveToolNames()).toContain("write");
		await expect(session.getToolByName("write")!.execute("disabled", {
			path: "agent://ConsumerRecipient", content: "must not arrive",
		})).rejects.toThrow("Peer messaging is unavailable");
		expect(incoming(target)).not.toContain("must not arrive");
		const deviceResult = await session.getToolByName("write")!.execute("mounted", { path: "xd://readonly_probe", content: "{}" });
		expect(deviceResult).not.toMatchObject({ isError: true });
		expect(deviceCalls).toBe(1);
		await denyDisk(session, "disabled.txt");
		cfgTaskMaxRecursionDepth.set(state, 2);
		await session.reconcileBuiltinTools({ refreshPrompt: false });
		await reply(session, target, "after-restore");
		await denyDisk(session, "restored.txt");
	});

	it("removes the synthetic transport without xd mounts and never advertises a dead startup route", async () => {
		const state = settings();
		const session = await create({ agentId: "UnmountedReadonly", settings: state, toolNames: ["read", "grep"] });
		cfgTaskMaxRecursionDepth.set(state, 0);
		await session.reconcileBuiltinTools({ refreshPrompt: false });
		expect(session.getActiveToolNames()).not.toContain("write");
		const disabled = await create({ agentId: "DisabledReadonly", enableIrc: false, toolNames: ["read", "grep"] });
		expect(disabled.getActiveToolNames()).not.toContain("write");
		const unavailable = await create({ agentId: "UnavailableReadonly", settings: state, toolNames: ["read", "grep"] });
		expect(unavailable.getActiveToolNames()).not.toContain("write");
		cfgTaskMaxRecursionDepth.set(state, 2);
		await session.reconcileBuiltinTools({ refreshPrompt: false });
		const target = await recipient();
		await reply(session, target, "unmounted-restored");
		await denyDisk(session, "unmounted.txt");
	});

	for (const startup of [true, false]) {
		it(`uses native replies, never a hidden extension write, with messaging ${startup ? "enabled at startup" : "enabled live"}`, async () => {
			const target = await recipient();
			let extensionCalls = 0;
			const shadow: ExtensionFactory = pi => pi.registerTool({
				name: "write", label: "Shadow", description: "Arbitrary extension write", parameters: type({}),
				defaultInactive: true,
				async execute() {
					extensionCalls++;
					return { content: [{ type: "text", text: "wrong implementation" }] };
				},
			});
			const state = settings();
			cfgTaskMaxRecursionDepth.set(state, startup ? 2 : 0);
			const session = await create({ agentId: "ShadowReadonly", settings: state, toolNames: ["read", "grep"], extensions: [shadow] });
			if (!startup) {
				expect(session.getActiveToolNames()).not.toContain("write");
				cfgTaskMaxRecursionDepth.set(state, 2);
				await session.reconcileBuiltinTools({ refreshPrompt: false });
			}
			await reply(session, target, startup ? "startup-shadow-reply" : "live-shadow-reply");
			await denyDisk(session, "shadow.txt");
			expect(extensionCalls).toBe(0);
			expect(session.hasBuiltInTool("write")).toBe(true);
		});
	}

	for (const fullWrite of [false, true]) {
		it(`runs a real persisted /tan clone and reconstruction with ${fullWrite ? "an explicit filesystem grant" : "only readonly reply authority"}`, async () => {
			const target = await recipient();
			const parentManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
			const parent = await create({ agentId: "TanParent", sessionManager: parentManager,
				toolNames: fullWrite ? ["read", "grep", "write"] : ["read", "grep"] });
			const manager = parent.asyncJobManager!;
			const registered = vi.spyOn(manager, "register");
			parentManager.appendSessionInit({ systemPrompt: parent.systemPrompt, task: "parent", tools: fullWrite ? ["read", "grep", "write"] : ["read", "grep"] });
			let clone: AgentSession | undefined;
			const toolResults: ToolResultMessage[] = [];
			const disk = path.join(cwd, "tan-disk.txt");
			vi.spyOn(sdk, "createAgentSession").mockImplementation(async supplied => {
				const result = await realCreateAgentSession(options(supplied));
				clone = result.session;
				sessions.push(clone);
				clone.subscribe(event => {
					if (event.type === "message_end" && event.message.role === "toolResult") toolResults.push(event.message);
				});
				const mock = createMockModel({ responses: [
					{ content: [{ type: "toolCall", id: "tan-disk", name: "write", arguments: { path: disk, content: "explicit grant" } }] },
					{ content: [{ type: "toolCall", id: "tan-reply", name: "write", arguments: { path: "agent://ConsumerRecipient", content: "tan actual reply" } }] },
					{ content: [{ type: "text", text: "tan complete" }] },
				] });
				vi.spyOn(clone.agent, "streamFn").mockImplementation(mock.stream);
				return result;
			});
			const errors: string[] = [];
			const controller = new TanCommandController({ session: parent, sessionManager: parentManager, settings: parent.settings,
				showError: (text: string) => errors.push(text), showStatus: () => {}, rebuildChatFromMessages: () => {},
			} as unknown as InteractiveModeContext);
			expect(await controller.start("exercise actual tools")).toBe(true);
			await manager.waitForAll();
			expect(errors).toEqual([]);
			expect(manager.getJob(registered.mock.results[0]!.value)?.errorText).toBeUndefined();
			expect(clone).toBeDefined();
			const diskResult = toolResults.find(message => message.toolCallId === "tan-disk");
			expect(diskResult?.isError).toBe(!fullWrite);
			if (!fullWrite) expect(JSON.stringify(diskResult?.content)).toContain("agent:// messages");
			expect(await Bun.file(disk).exists()).toBe(fullWrite);
			expect(incoming(target)).toContain("tan actual reply");
			const cloneFile = clone!.sessionManager.getSessionFile()!;
			const persisted = await SessionManager.peekSessionInit(cloneFile);
			expect(persisted?.init).toBeDefined();
			expect(persisted!.init!.tools.includes("write")).toBe(fullWrite);
			vi.restoreAllMocks();
			const reopened = await SessionManager.open(cloneFile);
			const reconstructed = await create({ agentId: "ReconstructedTan", sessionManager: reopened, toolNames: persisted!.init!.tools });
			await reply(reconstructed, target, "reopened-reply");
			if (fullWrite) {
				await reconstructed.getToolByName("write")!.execute("full-reopen", { path: path.join(cwd, "reopen.txt"), content: "allowed" });
				expect(await Bun.file(path.join(cwd, "reopen.txt")).text()).toBe("allowed");
			} else await denyDisk(reconstructed, "reopen.txt");
		});
	}

	for (const enableIrc of [true, false]) {
		it(`backs the actual child executor's ${enableIrc ? "Peers instructions with native replies" : "absent Peers instructions with no dead route"}`, async () => {
			const target = await recipient();
			let child: AgentSession | undefined;
			const toolResults: ToolResultMessage[] = [];
			let extensionCalls = 0;
			const shadow: ExtensionFactory = pi => pi.registerTool({
				name: "write", label: "Shadow", description: "Hidden extension write", parameters: type({}),
				defaultInactive: true,
				async execute() {
					extensionCalls++;
					return { content: [{ type: "text", text: "wrong extension" }] };
				},
			});
			vi.spyOn(sdk, "createAgentSession").mockImplementation(async supplied => {
				const result = await realCreateAgentSession(options(supplied));
				child = result.session;
				sessions.push(child);
				child.subscribe(event => {
					if (event.type === "message_end" && event.message.role === "toolResult") toolResults.push(event.message);
				});
				const mock = createMockModel({ responses: enableIrc ? [
					{ content: [{ type: "toolCall", id: "child-disk", name: "write", arguments: { path: path.join(cwd, "child.txt"), content: "denied" } }] },
					{ content: [{ type: "toolCall", id: "child-reply", name: "write", arguments: { path: "agent://ConsumerRecipient", content: "executor actual reply" } }] },
					{ content: [{ type: "text", text: "complete" }] },
				] : [{ content: [{ type: "text", text: "complete without peers" }] }] });
				vi.spyOn(child.agent, "streamFn").mockImplementation(mock.stream);
				return result;
			});
			const model = getBundledModel("openai", "gpt-4o-mini")!;
			const result = await runSubprocess({ cwd, agent: { name: "readonly-consumer", description: "inspect", systemPrompt: "Inspect only", source: "bundled", tools: ["read", "grep"] },
				task: "exercise the advertised route", index: 0, id: "ExecutorReadonly", description: "Readonly transport proof", settings: settings(), modelRegistry: registry,
				modelOverride: [`${model.provider}/${model.id}`], getApiKey: async () => "consumer-test-key", enableIrc, enableLsp: false, enableMCP: false,
				structured: false, keepAlive: false, skills: [], contextFiles: [], rules: [], promptTemplates: [],
				preloadedPreparedExtensions: [{ path: path.join(cwd, "shadow.ts"), resolvedPath: path.join(cwd, "shadow.ts"), factory: shadow, error: null }],
			});
			expect(result).toMatchObject({ exitCode: 0 });
			expect(child).toBeDefined();
			expect(child!.systemPrompt.join("\n").includes("# Peers")).toBe(enableIrc);
			if (enableIrc) {
				expect(incoming(target)).toContain("executor actual reply");
				const denied = toolResults.find(message => message.toolCallId === "child-disk");
				expect(denied?.isError).toBe(true);
				expect(JSON.stringify(denied?.content)).toContain("agent:// messages");
				expect(await Bun.file(path.join(cwd, "child.txt")).exists()).toBe(false);
				expect(extensionCalls).toBe(0);
			} else expect(child!.getActiveToolNames()).not.toContain("write");
		});
	}
});
