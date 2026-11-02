import { afterEach, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const temp = TempDir.createSync("@pi-eval-fork-");
let session: AgentSession | undefined;
let fork: AgentSession | undefined;
let auth: AuthStorage | undefined;

afterEach(async () => {
	await fork?.dispose();
	await session?.dispose();
	auth?.close();
	temp.removeSync();
});

it("keeps the compacted eval context in the fork's provider prefix", async () => {
	auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const settings = Settings.isolated({ "compaction.keepRecentTokens": 1 });
	const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
	const toolSession: ToolSession = {
		cwd: temp.path(),
		hasUI: false,
		settings,
		getSessionFile: () => manager.getSessionFile() ?? null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => "eval-fork-repro",
	};
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi =>
			pi.on("session_before_compact", event => ({
				compaction: {
					summary: "Earlier work was compacted.",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			})),
		temp.path(),
		new EventBus(),
		runtime,
		"eval-fork-repro",
	);
	const extensionRunner = new ExtensionRunner([extension], runtime, temp.path(), manager, registry);
	const makeAgent = (messages = manager.buildSessionContext().messages) =>
		new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
		});
	manager.appendMessage({ role: "user", content: "first turn", timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "eval-1", name: "eval", arguments: { code: "1+1" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "eval-1",
		toolName: "eval",
		content: [{ type: "text", text: "2" }],
		isError: false,
		timestamp: Date.now(),
	});
	manager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });
	session = new AgentSession({
		agent: makeAgent(),
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		extensionRunner,
		evalToolSession: toolSession,
	});
	await session.compact();
	const next = { role: "user", content: "after compaction", timestamp: Date.now() } satisfies AgentMessage;
	manager.appendMessage(next);
	session.agent.appendMessage(next);
	const file = session.sessionFile;
	if (!file) throw new Error("Expected a persisted session");
	await manager.flush();
	const forkManager = await SessionManager.forkFrom(file, temp.path(), path.join(temp.path(), "forks"));
	fork = new AgentSession({
		agent: makeAgent(forkManager.buildSessionContext().messages),
		sessionManager: forkManager,
		settings,
		modelRegistry: registry,
		evalToolSession: toolSession,
	});
	expect(
		fork.messages.map(message => ({
			role: message.role,
			content: "content" in message ? message.content : undefined,
		})),
	).toEqual(
		session.messages.map(message => ({
			role: message.role,
			content: "content" in message ? message.content : undefined,
		})),
	);
});
