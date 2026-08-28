import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, DeveloperMessage, Message, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Claude Opus 4.8 and the Fable/Mythos 5 generation support mid-conversation
 * `role: "system"` messages. Our `developer` messages (the system-priority
 * instructions we already emit as `developer`/`system` to OpenAI providers)
 * should map to that role on models that support it, while respecting
 * Anthropic's placement rules and falling back to `user` everywhere else.
 * @see https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
 */

function makeModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-opus-4-8-20260528",
		name: "Claude Opus 4.8",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		maxTokens: 64000,
		contextWindow: 1000000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function developer(text: string): DeveloperMessage {
	return { role: "developer", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistant(text: string, model: Model<"anthropic-messages">): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("Anthropic mid-conversation system messages", () => {
	it("maps a trailing developer message after a user turn to role: system", () => {
		const model = makeModel();
		const params = convertAnthropicMessages(
			[user("review utils.py"), developer("Use parameterized SQL.")],
			model,
			false,
		);

		expect(params.map(p => p.role)).toEqual(["user", "system"]);
		const sys = params[1];
		expect(sys.role).toBe("system");
		// A single text block collapses to a plain string, same as a user turn.
		expect(sys.content).toBe("Use parameterized SQL.");
		// A trailing system message is a valid final entry; no synthetic Continue.
		expect(params.at(-1)?.role).toBe("system");
	});

	it("keeps developer turns carrying image content as user messages", () => {
		const model = makeModel({ input: ["text", "image"] });
		const visualDeveloper: DeveloperMessage = {
			role: "developer",
			content: [
				{ type: "text", text: "Match this reference design." },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			timestamp: Date.now(),
		};
		const params = convertAnthropicMessages([user("hi"), visualDeveloper], model, false);
		// Placement qualifies (follows user, last entry), but system content is
		// text-only on the wire — the image-bearing turn must stay role: user.
		expect(params.map(p => p.role)).toEqual(["user", "user"]);
	});

	it("maps developer messages to system on Claude Mythos 5", () => {
		const model = makeModel({ id: "claude-mythos-5", name: "Claude Mythos 5" });
		const params = convertAnthropicMessages([user("hi"), developer("Use project rules.")], model, false);
		expect(params.map(p => p.role)).toEqual(["user", "system"]);
	});

	it("maps a developer message that precedes an assistant turn to role: system", () => {
		const model = makeModel();
		const params = convertAnthropicMessages(
			[user("hi"), developer("Be terse."), assistant("ok", model)],
			model,
			false,
		);
		// A trailing assistant turn appends the synthetic "Continue." user turn,
		// so assert the upgraded slot directly rather than the whole array.
		expect(params[0]?.role).toBe("user");
		expect(params[1]?.role).toBe("system");
		expect(params[2]?.role).toBe("assistant");
	});

	it("keeps a developer message following an assistant turn as user (must follow a user turn)", () => {
		const model = makeModel();
		const params = convertAnthropicMessages(
			[user("hi"), assistant("hello", model), developer("Switch to German.")],
			model,
			false,
		);
		expect(params.map(p => p.role)).toEqual(["user", "assistant", "user"]);
		expect(params.at(-1)?.content).toBe("Switch to German.");
	});

	it("never emits a developer message in the first position as system", () => {
		const model = makeModel();
		const params = convertAnthropicMessages([developer("Global rule."), user("hi")], model, false);
		// First entry cannot be a system message; followed by user, not assistant.
		expect(params.map(p => p.role)).toEqual(["user", "user"]);
	});

	it("upgrades only the trailing developer message in a consecutive run", () => {
		const model = makeModel();
		const params = convertAnthropicMessages(
			[user("hi"), developer("Rule A."), developer("Rule B."), assistant("ok", model)],
			model,
			false,
		);
		// Consecutive system messages are not allowed; the first stays user, only
		// the trailing developer (before the assistant turn) is upgraded.
		expect(params[1]?.role).toBe("user");
		expect(params[2]?.role).toBe("system");
		expect(params[3]?.role).toBe("assistant");
	});

	it("upgrades a developer message that follows tool results (a user-role param)", () => {
		const model = makeModel();
		const messages: Message[] = [
			user("run the build"),
			{
				...assistant("", model),
				content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { cmd: "build" } }],
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
			},
			developer("Treat failures as fatal."),
		];
		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map(p => p.role)).toEqual(["user", "assistant", "user", "system"]);
	});

	it("does not use the system role on models older than Opus 4.8", () => {
		const model = makeModel({ id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5" });
		const params = convertAnthropicMessages([user("hi"), developer("Be terse.")], model, false);
		expect(params.map(p => p.role)).toEqual(["user", "user"]);
	});

	it("does not use the system role on non-first-party endpoints", () => {
		const model = makeModel({ baseUrl: "https://openrouter.ai/api/v1", provider: "openrouter" });
		const params = convertAnthropicMessages([user("hi"), developer("Be terse.")], model, false);
		expect(params.map(p => p.role)).toEqual(["user", "user"]);
	});

	it("honors an explicit compat override on an otherwise-unsupported model", () => {
		const model = makeModel({
			id: "claude-sonnet-4-6-20260217",
			name: "Claude Sonnet 4.6",
			compat: { supportsMidConversationSystem: true },
		});
		const params = convertAnthropicMessages([user("hi"), developer("Be terse.")], model, false);
		expect(params.map(p => p.role)).toEqual(["user", "system"]);
	});

	it("honors an explicit compat override disabling the feature on Opus 4.8", () => {
		const model = makeModel({ compat: { supportsMidConversationSystem: false } });
		const params = convertAnthropicMessages([user("hi"), developer("Be terse.")], model, false);
		expect(params.map(p => p.role)).toEqual(["user", "user"]);
	});
});
