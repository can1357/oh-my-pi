import { expect, test } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionProviderBoundary } from "@oh-my-pi/pi-coding-agent/session/session-provider-boundary";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

test("native V2 reuses the pinned stateful context projection after another turn", async () => {
	using tempDir = TempDir.createSync("@omp-v2-projection-");
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	const model = getBundledModel("openai", "gpt-4o-mini");
	let calls = 0;
	const transformContext = async (messages: AgentMessage[]) => {
		calls++;
		const injected: AgentMessage[] = [
			{ role: "user", content: `date/cwd reminder ${calls}`, timestamp: 0 },
			{ role: "user", content: `extension insertion ${calls}`, timestamp: 0 },
		];
		return [...injected, ...messages.slice().reverse()];
	};
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["session instructions"],
			messages: [{ role: "user", content: "older", timestamp: 1 }],
			tools: [],
		},
		transformContext,
		streamFn: () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: createAssistantMessage("reply") }));
			return stream;
		},
	});
	await agent.prompt("current");
	const pinned = agent.lastPreparedProviderCall;
	if (!pinned) throw new Error("ordinary request did not complete preparation");
	const source = pinned.source.slice(0, pinned.sourceLength);
	const firstProjection = pinned.context.messages;
	await agent.prompt("newer ordinary turn");
	const afterNewTurn = calls;
	const boundary = new SessionProviderBoundary({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		model: () => model,
		sessionId: () => "projection-test",
		localProtocolOptions: () => ({}),
		transformContext,
		convertToLlm: messages =>
			messages.filter(
				message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			),
		onPayload: undefined,
		onResponse: undefined,
		onSseEvent: undefined,
		obfuscator: () => undefined,
	});
	const call = createAssistantMessage("reading");
	call.content = [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "file.txt" } }];
	const tail: AgentMessage = {
		role: "toolResult",
		toolCallId: "call-read",
		toolName: "read",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: 10,
	};
	const prepared = await boundary.buildOpenAiV2Context([...source, call, tail], model, pinned);
	expect(calls).toBe(afterNewTurn);
	expect(prepared?.systemPrompt).toEqual(pinned.context.systemPrompt);
	expect(prepared?.messages.slice(0, -2)).toEqual(firstProjection);
	expect(prepared?.messages.at(-2)).toMatchObject({ content: call.content });
	expect(prepared?.messages.at(-1)).toMatchObject({ role: "toolResult", content: tail.content });
	expect(prepared?.messages[0]).toMatchObject({ content: "date/cwd reminder 1" });
	expect(prepared?.messages[1]).toMatchObject({ content: "extension insertion 1" });
});
