/**
 * Session-level integration coverage for streamed edit preview recovery.
 *
 * Production failure this guards against: the native edit engine reports a
 * final preview error mid-stream ("Streaming edit preview failed"), the
 * StreamingEditGuard aborts the run, and the whole prompt used to die with no
 * retry, no re-drive, nothing. The guard now appends the preview diagnostic
 * and re-drives the turn so the model can read the file again and correct the
 * patch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Context, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";

const emptyUsage = (): AssistantMessage["usage"] => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** Concatenate the text of a user/developer/assistant LLM message. */
const messageText = (message: Message): string => {
	if (typeof message.content === "string") return message.content;
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
	}
	return text;
};

/**
 * First-call stream: the model emits an `edit` tool call whose final native
 * preview will fail (the diff context cannot match the file), then the
 * response stays open. In production the preview error lands while the
 * response is still streaming, so no `done` event is sent and only the
 * guard's abort can settle the run.
 */
const streamingEditFailureStream = (opts: {
	model: Model<Api>;
	args: Record<string, unknown>;
}): AssistantMessageEventStream => {
	const { model, args } = opts;
	const stream = new AssistantMessageEventStream();
	const toolCall = { type: "toolCall" as const, id: "edit-call-1", name: "edit", arguments: args };
	const partial: AssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial });
	stream.push({ type: "toolcall_start", contentIndex: 0, partial });
	const encoded = JSON.stringify(args);
	for (let offset = 0; offset < encoded.length; offset += 7) {
		stream.push({ type: "toolcall_delta", contentIndex: 0, delta: encoded.slice(offset, offset + 7), partial });
	}
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
	return stream;
};

/** Second-call stream: the re-driven turn answers with plain text. */
const textStream = (opts: { model: Model<Api>; text: string }): AssistantMessageEventStream => {
	const { model, text } = opts;
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
};

describe("AgentSession streaming edit preview recovery", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-streaming-edit-recovery-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	it("aborts the failed preview, then re-drives the model with the diagnostic", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "streaming-edit-recovery-"));
		try {
			await Bun.write(path.join(dir, "sample.txt"), "alpha\n");
			const settings = Settings.isolated({
				"edit.mode": "patch",
				"edit.streamingAbort": true,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"advisor.enabled": false,
			});
			const toolSession = {
				cwd: dir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				enableLsp: false,
				settings,
				getArtifactsDir: () => null,
				getSessionId: () => null,
				getPlanModeState: () => undefined,
			} as unknown as ToolSession;
			const editTool = new EditTool(toolSession, "patch");
			// EditTool narrows `params` beyond AgentTool's generic schema
			// (same cast the ACP permission tests use); the session registry
			// only consumes the AgentTool surface.
			const agentEditTool = editTool as AgentTool;

			const model = createMockModel({ provider: "anthropic", id: "claude-streaming-edit-recovery" }).model;
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			const contexts: Context[] = [];
			let call = 0;
			const agent = new Agent({
				getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
				initialState: { model, systemPrompt: ["Test"], tools: [agentEditTool], messages: [] },
				streamFn: (streamModel, context) => {
					contexts.push(context);
					call += 1;
					return call === 1
						? streamingEditFailureStream({
								model: streamModel,
								args: { path: "sample.txt", edits: [{ diff: "@@\n-missing\n+replacement\n" }] },
							})
						: textStream({ model: streamModel, text: "Recovered after preview failure." });
				},
				convertToLlm,
			});
			const active = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				toolRegistry: new Map([["edit", agentEditTool]]),
			});
			session = active;
			const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
			active.subscribe(event => {
				if (event.type === "notice") notices.push(event);
			});

			await active.prompt("Fix sample.txt");
			await active.waitForIdle();

			// The failed run was followed by a second model call: the guard
			// re-drove the turn instead of ending the prompt with nothing.
			expect(call).toBe(2);

			// The second call carried the hidden recovery prompt as a developer
			// message naming the diagnostic and the way out.
			const secondContext = contexts.at(1);
			if (!secondContext) throw new Error("expected a second model call after the aborted preview");
			const recoveryPrompt = secondContext.messages.find(
				m => m.role === "developer" && messageText(m).includes("Streaming edit preview failed"),
			);
			expect(recoveryPrompt).toBeDefined();
			if (recoveryPrompt) {
				const text = messageText(recoveryPrompt);
				expect(text).toContain("sample.txt");
				expect(text).toContain("Read the target file again");
			}

			// The user saw a notice explaining the retry.
			const notice = notices.find(entry => entry.source === "streaming-edit");
			expect(notice?.message).toContain("attempt 1/2");

			const messages = active.agent.state.messages;
			const aborted = messages.find(
				(m): m is AssistantMessage => m.role === "assistant" && m.stopReason === "aborted",
			);
			expect(aborted).toBeDefined();
			expect(aborted?.errorMessage ?? "").toContain("Streaming edit preview failed");

			// The unexecuted edit call stays paired with its aborted placeholder.
			const placeholder = messages.find(m => m.role === "toolResult" && m.toolCallId === "edit-call-1");
			expect(placeholder).toBeDefined();
			expect(JSON.stringify(placeholder)).toContain("Tool execution was aborted");

			const recoveryEntry = messages.find(m => m.role === "custom" && m.customType === "streaming-edit-recovery");
			expect(recoveryEntry).toBeDefined();
			if (recoveryEntry && recoveryEntry.role === "custom") expect(recoveryEntry.display).toBe(false);

			const finalAssistant = messages.findLast(
				(m): m is AssistantMessage => m.role === "assistant" && m.stopReason === "stop" && !m.errorMessage,
			);
			if (!finalAssistant) throw new Error("expected a recovered final assistant message");
			expect(messageText(finalAssistant)).toContain("Recovered");
		} finally {
			await removeWithRetries(dir);
		}
	}, 20_000);
});
