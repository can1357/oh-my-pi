import { type MessagePort, parentPort } from "node:worker_threads";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { hindsightBackend } from "../../src/hindsight/backend";
import type { HindsightSessionStateApi } from "../../src/hindsight/state";
import { mnemopiBackend } from "../../src/mnemopi/backend";
import type { MnemopiSessionStateApi } from "../../src/mnemopi/state";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { memoryThreadService } from "../../src/thread/services/memory";
import {
	RemoteHindsightBankSet,
	RemoteHindsightClient,
	RemoteHindsightSessionState,
	RemoteMnemopiSessionState,
} from "../../src/thread/services/memory-remote";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

/** What a worker-hosted Hindsight child saw and did through its alias. */
export interface HindsightChildReport {
	childSessionId: string;
	aliasesRemoteParent: boolean;
	remoteClient: boolean;
	remoteBankSet: boolean;
	bankId: string;
	recalled: string | null;
	instructions: string | undefined;
}

/** What a worker-hosted Mnemopi child saw and did through its alias. */
export interface MnemopiChildReport {
	aliasesRemoteParent: boolean;
	storedId: string;
	recalledIds: string[];
	readBack: string | undefined;
	workingCount: number | undefined;
}

/** Worker-side operations the test drives; each crosses to main as an async function. */
export interface MemoryProbe {
	hindsightChild(parent: HindsightSessionStateApi, fact: string, query: string): Promise<HindsightChildReport>;
	mnemopiChild(parent: MnemopiSessionStateApi, fact: string): Promise<MnemopiChildReport>;
	mnemopiForget(id: string): Promise<string>;
}

/** Test-only boot globals next to the services' own. */
export interface MemoryTestGlobals {
	ready(probe: MemoryProbe): void;
}

function isTestGlobals(value: unknown): value is MemoryTestGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("memory fixture: bundled anthropic/claude-sonnet-4-5 missing");
const modelRegistry = new ModelRegistry(createInMemoryAuthStorage());

function childSession(settings: Settings): AgentSession {
	return new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Child"], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry,
	});
}

function buildProbe(): MemoryProbe {
	let mnemopiChild: AgentSession | undefined;
	return {
		hindsightChild: async (parent, fact, query) => {
			await using outboxDir = await TempDir.create("@memory-bridge-outbox-");
			const settings = Settings.isolated({
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://hindsight.invalid",
			});
			const session = childSession(settings);
			await hindsightBackend.start({
				session,
				settings,
				modelRegistry,
				agentDir: outboxDir.path(),
				taskDepth: 1,
				parentHindsightSessionState: parent,
			});
			const alias = session.getHindsightSessionState();
			if (!alias) throw new Error("hindsight alias was not installed");
			// The retain/recall tools act on the session's own (alias) state.
			await alias.enqueueRetain("worker-retain", [{ content: fact, context: "from worker" }]);
			await alias.flushRetainQueue();
			const { context } = await alias.recallForContext(query);
			const instructions = await hindsightBackend.buildDeveloperInstructions("/tmp", "/tmp", settings, session);
			const report: HindsightChildReport = {
				childSessionId: session.sessionId,
				aliasesRemoteParent: alias.aliasOf === parent && parent instanceof RemoteHindsightSessionState,
				remoteClient: alias.client instanceof RemoteHindsightClient,
				remoteBankSet: alias.banksSet instanceof RemoteHindsightBankSet,
				bankId: alias.bankId,
				recalled: context,
				instructions,
			};
			await session.dispose();
			return report;
		},
		mnemopiChild: async (parent, fact) => {
			const settings = Settings.isolated({ "memory.backend": "mnemopi" });
			const session = childSession(settings);
			mnemopiChild = session;
			await mnemopiBackend.start({
				session,
				settings,
				modelRegistry,
				agentDir: "/tmp",
				taskDepth: 1,
				parentMnemopiSessionState: parent,
			});
			const alias = session.getMnemopiSessionState();
			if (!alias) throw new Error("mnemopi alias was not installed");
			// The retain tool's write path.
			const storedId = alias.rememberScoped(fact, { source: "worker-test", scope: "bank", extract: false });
			const recalled = await alias.recallResultsScoped(fact);
			const status = await mnemopiBackend.status?.({ agentDir: "/tmp", cwd: "/tmp", session });
			return {
				aliasesRemoteParent: alias.aliasOf === parent && parent instanceof RemoteMnemopiSessionState,
				storedId,
				recalledIds: recalled.map(result => result.id),
				readBack: alias.getScopedMemory(storedId)?.row.content,
				workingCount: status?.workingCount,
			};
		},
		mnemopiForget: async id => {
			const alias = mnemopiChild?.getMnemopiSessionState();
			if (!alias) throw new Error("no mnemopi child");
			return alias.editScopedMemory("forget", id).status;
		},
	};
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "memory-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	memoryThreadService.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("memory fixture: missing test globals");
		await test.ready(buildProbe());
	});
	port.postMessage({ ready: true });
});
