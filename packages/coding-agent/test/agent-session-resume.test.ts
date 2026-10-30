/**
 * Contract: the `.`/`c` continue shortcut (`AgentSession.resume`) re-runs a
 * prompt the model has not answered yet without adding any message, and only
 * injects the hidden manual-continue directive after an answered turn.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import manualContinuePrompt from "../src/prompts/system/manual-continue.md" with { type: "text" };

/** A response that stalls until aborted; `started` resolves once the request is in flight. */
function stalledResponse(): { handler: MockHandler; started: Promise<void> } {
	const started = Promise.withResolvers<void>();
	return {
		started: started.promise,
		handler: () => {
			started.resolve();
			return { content: ["too late"], delayMs: 60_000 };
		},
	};
}

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

describe("AgentSession.resume", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-resume-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(responses: MockHandler[]): { session: AgentSession; mock: MockModel } {
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		return { session, mock };
	}

	async function abortDuring(target: AgentSession, prompt: Promise<unknown>, started: Promise<void>): Promise<void> {
		await started;
		await target.abort();
		await prompt;
		await target.waitForIdle();
	}

	it("re-runs a prompt interrupted before any output without adding a message", async () => {
		const stall = stalledResponse();
		const { session, mock } = createSession([stall.handler, { content: ["answer"] }]);
		await abortDuring(session, session.prompt("do the thing"), stall.started);

		await session.resume();
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(session.agent.state.messages.map(message => [message.role, textOf(message)])).toEqual([
			["user", "do the thing"],
			["assistant", "answer"],
		]);
	});

	it("hands the re-run prompt to the turn observer as the turn's trigger", async () => {
		const stall = stalledResponse();
		const { session } = createSession([stall.handler, { content: ["answer"] }]);
		await abortDuring(session, session.prompt("do the thing"), stall.started);
		const observed: string[][] = [];
		session.setIrcWakeTurnObserver(records => {
			observed.push(records.map(textOf));
			return () => {};
		});

		await session.resume();
		await session.waitForIdle();

		// A focused subagent's result reaches its parent only when the observer sees the operator's prompt (#14428).
		expect(observed).toEqual([["do the thing"]]);
	});

	it("injects the continue directive after an answered turn", async () => {
		const { session } = createSession([{ content: ["done"] }, { content: ["more"] }]);
		await session.prompt("do the thing");

		await session.resume();
		await session.waitForIdle();

		expect(session.agent.state.messages.map(message => [message.role, textOf(message)])).toEqual([
			["user", "do the thing"],
			["assistant", "done"],
			["developer", manualContinuePrompt],
			["assistant", "more"],
		]);
	});

	it("re-runs an interrupted continue directive instead of stacking another", async () => {
		const stall = stalledResponse();
		const { session } = createSession([{ content: ["done"] }, stall.handler, { content: ["more"] }]);
		await session.prompt("do the thing");
		await abortDuring(session, session.resume(), stall.started);

		await session.resume();
		await session.waitForIdle();

		expect(session.agent.state.messages.map(message => [message.role, textOf(message)])).toEqual([
			["user", "do the thing"],
			["assistant", "done"],
			["developer", manualContinuePrompt],
			["assistant", "more"],
		]);
	});
});
