/**
 * Tests for secrets regex parsing, compilation, and obfuscation.
 */

import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import type { AssistantMessage, Context, Message } from "@pk-nerdsaver-ai/pi-ai";
import {
	deobfuscateAgentMessages,
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateProviderContext,
	SecretObfuscator,
} from "@pk-nerdsaver-ai/pi-coding-agent/secrets/obfuscator";
import { compileSecretRegex } from "@pk-nerdsaver-ai/pi-coding-agent/secrets/regex";
import { type } from "arktype";

describe("compileSecretRegex", () => {
	it("adds global flag when not provided", () => {
		const regex = compileSecretRegex("api[_-]?key\\s*=\\s*\\w+", "i");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("gi");
	});

	it("defaults to global flag when no flags provided", () => {
		const regex = compileSecretRegex("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("g");
	});

	it("rejects invalid regex pattern", () => {
		expect(() => compileSecretRegex("(")).toThrow();
	});
	it("rejects invalid regex flags", () => {
		expect(() => compileSecretRegex("x", "zz")).toThrow();
	});
});

describe("SecretObfuscator regex behavior", () => {
	it("obfuscates and deobfuscates regex matches with flags", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+", flags: "i" }]);
		const original = "API_KEY=abc and api-key=def";
		const obfuscated = obfuscator.obfuscate(original);
		expect(obfuscated).not.toEqual(original);
		expect(obfuscator.deobfuscate(obfuscated)).toEqual(original);
	});

	it("supports bare regex patterns without explicit flags", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+" }]);
		const text = "api_key=abc and API_KEY=def";
		const obfuscated = obfuscator.obfuscate(text);
		expect(obfuscated).not.toEqual(text);
		expect(obfuscator.deobfuscate(obfuscated)).toEqual(text);
	});
	it("deobfuscates placeholders through tool-call arguments", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+", flags: "i" }]);
		const original = { cmd: "API_KEY=abc and api-key=def", status: "ok", nested: { note: "API_KEY=zzz" } };
		const obfuscated = {
			cmd: obfuscator.obfuscate(original.cmd),
			status: original.status,
			nested: { note: obfuscator.obfuscate(original.nested.note) },
		};
		expect(JSON.stringify(obfuscated)).not.toContain("API_KEY=abc");
		expect(deobfuscateToolArguments(obfuscator, obfuscated)).toEqual(original);
	});

	it("obfuscates conversation messages but leaves the system prompt untouched", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const context: Context = {
			systemPrompt: [`workspace contains ${secret}`],
			messages: [{ role: "user", content: `use ${secret}`, timestamp: 1 }],
		};

		const obfuscated = obfuscateProviderContext(obfuscator, context);

		// Conversation messages are redacted (and round-trip back to the secret)...
		expect(JSON.stringify(obfuscated.messages)).not.toContain(secret);
		expect(obfuscator.deobfuscate(JSON.stringify(obfuscated.messages))).toContain(secret);
		// ...but the author-controlled system prompt passes through by reference.
		expect(obfuscated.systemPrompt).toBe(context.systemPrompt);
	});

	it("leaves tool schemas untouched in provider context (no clone, no redaction)", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const parameters = type({
			note: "string",
		}).describe(`write ${secret}`);
		const context: Context = {
			messages: [],
			tools: [
				{
					name: "extension_tool",
					description: `preserve ${secret}`,
					parameters,
				},
			],
		};

		const obfuscated = obfuscateProviderContext(obfuscator, context);

		expect(obfuscated.tools).toBe(context.tools);
		expect(obfuscated.tools?.[0]?.parameters).toBe(parameters);
	});

	it("redacts only user, tool-result, and user-attributed developer messages", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const userMsg: Message = { role: "user", content: `user says ${secret}`, timestamp: 1 };
		const systemDeveloperMsg: Message = { role: "developer", content: `system reminder ${secret}`, timestamp: 1 };
		const fileMentionMsg: Message = {
			role: "developer",
			content: `<file>${secret}</file>`,
			attribution: "user",
			timestamp: 1,
		};
		const assistantMsg: Message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "handoff",
					arguments: { note: secret },
					intent: `handoff ${secret}`,
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		const toolResultMsg: Message = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: `tool output ${secret}` }],
			isError: false,
			timestamp: 1,
		};

		const obfuscated = obfuscateMessages(obfuscator, [
			userMsg,
			systemDeveloperMsg,
			fileMentionMsg,
			assistantMsg,
			toolResultMsg,
		]);

		// User, user-attributed developer, and tool results are redacted.
		expect(JSON.stringify(obfuscated[0])).not.toContain(secret);
		expect(JSON.stringify(obfuscated[2])).not.toContain(secret);
		expect(JSON.stringify(obfuscated[4])).not.toContain(secret);
		// System developer reminders and assistant output pass through untouched (same reference).
		expect(obfuscated[1]).toBe(systemDeveloperMsg);
		expect(obfuscated[3]).toBe(assistantMsg);
	});

	it("never rewrites inline image bytes", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		// A base64 payload that literally contains the secret substring must survive byte-identical;
		// rewriting it would corrupt the data URL (the Codex "invalid base64" failure).
		const imageData = `iVBORw0KGgo${secret}AAAASUVORK5CYII=`;
		const message: Message = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [
				{ type: "text", text: `read ${secret}` },
				{ type: "image", data: imageData, mimeType: "image/png" },
			],
			isError: false,
			timestamp: 1,
		};

		const [obfuscated] = obfuscateMessages(obfuscator, [message]) as [typeof message];
		const blocks = obfuscated.content;
		const image = blocks[1];
		const text = blocks[0];
		// Image bytes untouched...
		expect(image.type === "image" && image.data).toBe(imageData);
		// ...while the adjacent text is redacted.
		expect(text.type === "text" && text.text.includes(secret)).toBe(false);
	});

	it("ignores configured plain secrets shorter than 8 characters", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "esp" }]);
		expect(obfuscator.hasSecrets()).toBe(false);
		expect(obfuscator.obfuscate("the response despite whitespace")).toBe("the response despite whitespace");
	});

	it("ignores regex matches shorter than 8 characters", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "esp" }]);
		expect(obfuscator.obfuscate("the response despite whitespace")).toBe("the response despite whitespace");
	});
});

describe("SecretObfuscator cross-turn cache stability", () => {
	// The provider prompt cache is content-addressed: convertToLlm / transformProviderContext
	// re-run obfuscation over the WHOLE message array every turn, so a non-deterministic
	// placeholder for the same secret would rewrite already-sent prefix bytes and bust the
	// cache (cacheWrite @ $6.25/M vs cacheRead @ $0.50/M on opus). These tests pin the
	// determinism that makes obfuscation cache-safe so a future change cannot silently
	// reintroduce per-turn cache invalidation.
	it("produces byte-identical output when re-obfuscating the same content across turns", () => {
		const secret = "SUPER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: secret },
			{ type: "regex", content: "tok_[a-z0-9]+" },
		]);
		const messages: Message[] = [{ role: "user", content: `use ${secret} and tok_abc123`, timestamp: 1 }];

		const turn1 = JSON.stringify(obfuscateMessages(obfuscator, messages));
		const turn2 = JSON.stringify(obfuscateMessages(obfuscator, messages));

		expect(turn1).not.toContain(secret);
		expect(turn1).not.toContain("tok_abc123");
		// Identical bytes on the second pass → the cached prefix stays valid.
		expect(turn2).toEqual(turn1);
	});

	it("keeps earlier message placeholders stable when a later message reveals a new regex secret", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "tok_[a-z0-9]+" }]);
		const early: Message[] = [{ role: "user", content: "first uses tok_aaaa", timestamp: 1 }];

		// Turn N: only the early message exists; tok_aaa mints a fresh placeholder.
		const earlyTurnN = JSON.stringify(obfuscateMessages(obfuscator, early));
		expect(earlyTurnN).not.toContain("tok_aaaa");

		// A later turn reveals a brand-new secret. Lazy regex discovery assigns it a fresh
		// index — this MUST NOT shift the placeholder already minted for tok_aaa.
		const later: Message[] = [{ role: "user", content: "later uses tok_bbbb", timestamp: 2 }];
		const laterOut = JSON.stringify(obfuscateMessages(obfuscator, later));
		expect(laterOut).not.toContain("tok_bbbb");

		// Re-obfuscate the early message after the new discovery: identical bytes → the
		// already-cached prefix for the early message stays valid.
		const earlyTurnNPlus1 = JSON.stringify(obfuscateMessages(obfuscator, early));
		expect(earlyTurnNPlus1).toEqual(earlyTurnN);
	});
});

describe("deobfuscateAgentMessages (display restore)", () => {
	it("restores assistant text and tool calls while leaving raw user text and thinking untouched", () => {
		const secret = "DISPLAY_SECRET_TOKEN_123";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		expect(placeholder).not.toBe(secret);

		const userMsg: AgentMessage = { role: "user", content: `literal ${placeholder} token`, timestamp: 1 };
		const assistantMsg: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: `answer ${placeholder}` },
				{ type: "thinking", thinking: `reason ${placeholder}` },
				{
					type: "toolCall",
					id: "call_1",
					name: "read",
					arguments: { path: `path ${placeholder}` },
					intent: `intent ${placeholder}`,
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const branchSummary: AgentMessage = {
			role: "branchSummary",
			summary: `branch ${placeholder}`,
			fromId: "x",
			timestamp: 3,
		};
		const compactionSummary: AgentMessage = {
			role: "compactionSummary",
			summary: `compact ${placeholder}`,
			shortSummary: `short ${placeholder}`,
			tokensBefore: 0,
			timestamp: 4,
		};

		const restored = deobfuscateAgentMessages(obfuscator, [userMsg, assistantMsg, branchSummary, compactionSummary]);

		// Assistant text and tool-call args/intent are restored to the real secret.
		const restoredAssistant = restored[1] as AssistantMessage;
		const assistantJson = JSON.stringify(restoredAssistant.content);
		expect(assistantJson).toContain(secret);
		expect(assistantJson).not.toContain(`answer ${placeholder}`);
		expect(assistantJson).not.toContain(`path ${placeholder}`);
		expect(assistantJson).not.toContain(`intent ${placeholder}`);
		// Opaque thinking is never walked: placeholder-shaped bytes survive unchanged.
		expect(assistantJson).toContain(`reason ${placeholder}`);
		expect(assistantJson).not.toContain(`reason ${secret}`);
		// Model-generated summaries are restored.
		expect((restored[2] as { summary: string }).summary).toBe(`branch ${secret}`);
		expect((restored[3] as { summary: string; shortSummary?: string }).summary).toBe(`compact ${secret}`);
		expect((restored[3] as { summary: string; shortSummary?: string }).shortSummary).toBe(`short ${secret}`);
		// The user message is persisted raw and never walked: a literal placeholder-shaped token
		// survives byte-identical (same reference) rather than being turned into the secret.
		expect(restored[0]).toBe(userMsg);
	});

	it("restores compactionSummary block text while leaving snapcompact image bytes intact", () => {
		const secret = "BLOCKS_SECRET_TOKEN_456";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		const imageData = `frame${secret}bytes==`;
		const message: AgentMessage = {
			role: "compactionSummary",
			summary: `summary ${placeholder}`,
			tokensBefore: 0,
			blocks: [
				{ type: "text", text: `archived ${placeholder}` },
				{ type: "image", data: imageData, mimeType: "image/png" },
			],
			timestamp: 1,
		};

		const [restored] = deobfuscateAgentMessages(obfuscator, [message]) as [typeof message];
		const blocks = restored.blocks ?? [];
		const text = blocks[0];
		const image = blocks[1];
		// Archived text is restored to the real secret...
		expect(text.type === "text" && text.text).toBe(`archived ${secret}`);
		// ...while the snapcompact image bytes pass through untouched.
		expect(image.type === "image" && image.data).toBe(imageData);
	});
});
