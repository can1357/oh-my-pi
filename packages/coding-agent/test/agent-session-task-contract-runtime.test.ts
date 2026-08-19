import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import { createMockModel } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { buildCompletionGateInputFromTranscript } from "../src/orchestration/root-completion-gate";

/** Extract the textual payload of a message whether its content is a plain string
 *  or an array of content blocks, narrowing each block before reading `.text`. */
function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		) {
			texts.push(block.text);
		}
	}
	return texts.join("");
}

/** Return the executor-block XML carried by the hidden `task-contract-notice`, or
 *  undefined when no such notice was prepended to the turn. */
function contractNoticeText(messages: readonly AgentMessage[]): string | undefined {
	for (const message of messages) {
		if ("customType" in message && message.customType === "task-contract-notice") {
			return textOf(message);
		}
	}
	return undefined;
}

describe("AgentSession task-contract runtime", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-task-contract-runtime-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
	});

	async function makeSession(): Promise<AgentSession> {
		const model = createMockModel().model;
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
	}
	async function makeStreamingSession(
		responses: NonNullable<Parameters<typeof createMockModel>[0]>["responses"],
	): Promise<AgentSession> {
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
	}

	/** Spy on the agent's prompt entry point so each turn's full message array —
	 *  including the hidden task-contract-notice — is captured without driving a
	 *  real model call. The compiled-contract state still mutates per turn. */
	function capturePromptTurns(target: AgentSession): AgentMessage[][] {
		const captures: AgentMessage[][] = [];
		vi.spyOn(target.agent, "prompt").mockImplementation(async (...args: unknown[]) => {
			const messages = args[0];
			if (!Array.isArray(messages)) throw new Error("Expected an AgentMessage array");
			captures.push(messages as AgentMessage[]);
		});
		return captures;
	}

	it("emits a hidden task-contract-notice with the executor block for a substantial request", async () => {
		session = await makeSession();
		const captures = capturePromptTurns(session);

		await session.prompt("Implement the auth service with OAuth2");

		expect(captures.length).toBe(1);
		const block = contractNoticeText(captures[0]!);
		expect(block).toBeDefined();
		expect(block).toContain("<task-contract");
		expect(block).toContain("auth service");
	});
	it("continues a compiled root task when its first stop lacks verification evidence", async () => {
		session = await makeStreamingSession([{ content: ["I implemented auth."] }]);

		await session.prompt("Implement the auth flow");
		await session.waitForIdle();

		expect(
			session.agent.state.messages.some(
				message => message.role === "developer" && textOf(message).includes("Completion gate reminder 1/2"),
			),
		).toBe(true);
	});

	it("passes the compiled root gate after verification evidence", async () => {
		session = await makeSession();
		capturePromptTurns(session);

		await session.prompt("Implement the auth flow");
		const contract = session.getActiveTaskContract();
		if (!contract) throw new Error("Expected compiled root contract to activate the completion gate");

		const timestamp = Date.now();
		session.agent.appendMessage({
			role: "toolResult",
			toolCallId: "bash-check",
			toolName: "bash",
			content: [{ type: "text", text: "tests pass" }],
			isError: false,
			timestamp,
		});
		session.agent.appendMessage({
			role: "toolResult",
			toolCallId: "read-check",
			toolName: "read",
			content: [{ type: "text", text: "implementation reviewed" }],
			isError: false,
			timestamp: timestamp + 1,
		});

		const evaluation = session.evaluateRootCompletionGate(
			buildCompletionGateInputFromTranscript(contract, session.agent.state.messages, timestamp),
		);
		expect(evaluation.outcome).toBe("pass");
	});

	it("keeps the executor and live advisor on the same digest", async () => {
		session = await makeSession();
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const captures = capturePromptTurns(session);

		await session.prompt("Implement the auth service with OAuth2");

		const executorBlock = contractNoticeText(captures[0]!);
		const digest = executorBlock?.match(/digest="([^"]+)"/)?.[1];
		if (!digest) throw new Error("Expected executor contract digest");
		const advisor = session.getAdvisorAgent();
		expect(advisor).toBeDefined();
		expect(advisor!.state.systemPrompt.join("\n")).toContain(`digest="${digest}"`);
	});

	it("does not emit a contract notice for a trivial conversational request", async () => {
		session = await makeSession();
		const captures = capturePromptTurns(session);

		await session.prompt("hello there");

		expect(captures.length).toBe(1);
		expect(contractNoticeText(captures[0]!)).toBeUndefined();
	});

	it("consumes one answer and blocks remaining hard gaps without asking another question", async () => {
		session = await makeSession();
		const captures = capturePromptTurns(session);

		await session.prompt("Implement the release; delete temporary secrets then deploy to production");
		const firstBlock = contractNoticeText(captures[0]!);
		expect(firstBlock).toBeDefined();
		expect(firstBlock).toContain("<unresolved>");
		expect(firstBlock).toContain("question=");

		await session.prompt("temporary secrets only");
		expect(captures.length).toBe(2);
		const answeredBlock = contractNoticeText(captures[1]!);
		expect(answeredBlock).toBeDefined();
		expect(answeredBlock).toContain("temporary secrets only");
		expect(answeredBlock).toContain('<unresolved blocked="true">');
		expect(answeredBlock).not.toContain("question=");
	});

	it("retains the executor contract through an automatic retry", async () => {
		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=1" },
				{ content: ["recovered"] },
			],
		});
		const model = mock.model;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": 1,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});

		await session.prompt("Implement the auth service with OAuth2");
		await session.waitForIdle();

		const retainedContract = session.agent.state.messages.some(message =>
			contractNoticeText([message])?.includes("<task-contract"),
		);
		expect(retainedContract).toBe(true);
	});
	it("newSession resets compiled contract state so a fresh request re-asks its question", async () => {
		session = await makeSession();
		const captures = capturePromptTurns(session);

		await session.prompt("Implement the release; deploy to production");
		expect(contractNoticeText(captures[0]!)).toContain("<unresolved>");

		// A new session clears the ephemeral compiled contract (and any pending
		// clarification), so the same request compiles fresh instead of being
		// swallowed as the prior clarification's answer.
		await session.newSession();
		await session.prompt("Implement the release; deploy to production");

		const afterReset = contractNoticeText(captures[1]!);
		expect(afterReset).toBeDefined();
		expect(afterReset).toContain("<unresolved>");
	});
});
