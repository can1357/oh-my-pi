import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { IrcBus } from "../../src/irc/bus";
import { createPrintPromptResults } from "../../src/modes/print-mode";
import { RpcPromptResults } from "../../src/modes/rpc/rpc-prompt-results";
import type { RpcPromptResultFrame } from "../../src/modes/rpc/rpc-types";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { EventBus } from "../../src/utils/event-bus";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

let temp: TempDir;
let session: AgentSession | undefined;
let auth: AuthStorage;
beforeEach(() => {
	temp = TempDir.createSync("@omp-messaging-attribution-");
	auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("openai", "test-key");
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});
afterEach(async () => {
	await session?.dispose();
	session = undefined;
	auth.close();
	vi.restoreAllMocks();
	temp.removeSync();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

test.each([
	[false, "getApiKey"],
	[true, "getApiKey"],
	[true, "before_agent_start"],
] as const)("a pending peer wake respects admitted CLI setup (abort=%s, gate=%s)", async (abortCli, gate) => {
	const model = createMockModel({ provider: "openai", id: "messaging-attribution-test" }).model;
	const contexts: string[] = [];
	const outputs: string[] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Attribution harness"], tools: [], messages: [] },
		convertToLlm,
		streamFn: (_model, context) => {
			const text = JSON.stringify(context.messages);
			contexts.push(text);
			const answer = text.includes("CLI_REQUEST") ? "CLI_ANSWER" : "PEER_ANSWER";
			outputs.push(answer);
			const message = {
				...createAssistantMessage(answer),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		},
	});
	const settings = Settings.isolated({
		"tools.approvalMode": "yolo",
		"compaction.enabled": false,
		"todo.enabled": false,
		"ttsr.enabled": false,
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const registry = new ModelRegistry(auth);
	const setupEntered = Promise.withResolvers<void>();
	const setupRelease = Promise.withResolvers<void>();
	const manager = SessionManager.inMemory(temp.path());
	let extensionRunner: ExtensionRunner | undefined;
	if (gate === "before_agent_start") {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("before_agent_start", async () => {
					setupEntered.resolve();
					await setupRelease.promise;
				});
			},
			temp.path(),
			new EventBus(),
			runtime,
			"messaging-setup-latch",
		);
		extensionRunner = new ExtensionRunner([extension], runtime, temp.path(), manager, registry);
	} else {
		vi.spyOn(registry, "getApiKey").mockImplementation(async () => {
			setupEntered.resolve();
			await setupRelease.promise;
			return "test-key";
		});
	}
	const current = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		extensionRunner,
		agentId: MAIN_AGENT_ID,
		agentKind: "main",
		toolRegistry: new Map(),
	});
	session = current;
	const wakeRelease = Promise.withResolvers<void>();
	vi.spyOn(current, "whenWorkPoolYieldSettled").mockReturnValue(wakeRelease.promise);
	let setupWindow = false;
	let peerStartsDuringSetup = 0;
	let cliUnwinding = false;
	let peerStartsWhileCliUnwinding = 0;
	const peerFinished = Promise.withResolvers<void>();
	agent.subscribe(event => {
		if (event.type === "agent_start" && setupWindow) peerStartsDuringSetup++;
		if (event.type === "agent_start" && cliUnwinding) peerStartsWhileCliUnwinding++;
		if (event.type === "agent_end" && setupWindow) peerFinished.resolve();
	});
	const printResults = createPrintPromptResults(current);
	const frame = Promise.withResolvers<RpcPromptResultFrame>();
	const rpcResults = new RpcPromptResults(current, frame.resolve);
	current.subscribe(event => {
		printResults.observe(event);
		rpcResults.observe(event);
	});
	let ticketText: string | null = null;
	const printCompleted = Promise.withResolvers<void>();
	const printTicket = printResults.begin(undefined, message => {
		ticketText =
			message?.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("") ?? null;
		printCompleted.resolve();
	});
	const rpcTicket = rpcResults.begin("cli");
	await current.deliverIrcMessage({
		id: "pending-peer",
		from: "Peer",
		to: MAIN_AGENT_ID,
		body: "PEER_REQUEST",
		ts: Date.now(),
	});
	const prompt = current.prompt("CLI_REQUEST", {
		onPromptAdmitted: () => {
			setupWindow = true;
			printResults.admit(printTicket);
			rpcResults.admit(rpcTicket);
			// The wake was scheduled while idle; release it only after CLI setup is held.
			void setupEntered.promise.then(() => wakeRelease.resolve());
		},
	});
	await setupEntered.promise;
	const setupTick = Promise.withResolvers<void>();
	setImmediate(setupTick.resolve);
	await setupTick.promise;
	if (peerStartsDuringSetup > 0) await peerFinished.promise;
	// Abort synchronously invalidates CLI setup. Do not await it against the held gate.
	cliUnwinding = abortCli;
	const aborted = abortCli ? current.abort() : undefined;
	setupWindow = false;
	setupRelease.resolve();
	await prompt;
	cliUnwinding = false;
	printResults.settle(printTicket);
	rpcResults.settle(rpcTicket);
	await printCompleted.promise;
	const reported = await frame.promise;
	await aborted;
	await current.waitForIdle();
	const settleTick = Promise.withResolvers<void>();
	setImmediate(settleTick.resolve);
	await settleTick.promise;
	await current.waitForIdle();

	expect(peerStartsDuringSetup).toBe(0);
	expect(peerStartsWhileCliUnwinding).toBe(0);
	expect(reported.status).toBe(abortCli ? "aborted" : "completed");
	expect<string | null>(ticketText).toBe(abortCli ? null : "CLI_ANSWER");
	expect(contexts.some(text => text.includes("PEER_REQUEST"))).toBe(true);
	expect(JSON.stringify(current.messages)).toContain("PEER_REQUEST");
	if (abortCli) expect(outputs).toEqual(["PEER_ANSWER"]);
});
