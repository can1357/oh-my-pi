import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { deobfuscateSessionContext, obfuscateMessages } from "@oh-my-pi/pi-coding-agent/secrets";
import { type SecretEntry, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";

const KEY = "codec-test-placeholder-key-0123456789";
const WORDS = "[a-z]+(?:[A-Z][a-z]+){3}";

function assistant(text: string, thinking: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking, thinkingSignature: "sig-opaque" },
			{ type: "text", text },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function context(messages: AgentMessage[]): SessionContext {
	const partial: Partial<SessionContext> = { messages, models: {}, injectedTtsrRules: [], mode: "none" };
	return partial as SessionContext;
}

describe("secret placeholders", () => {
	it("are four camelCase words after the friendly name, stable for one key and different across keys", () => {
		const entries: SecretEntry[] = [{ type: "plain", content: "hunter2-database-pass", friendlyName: "Db Pass" }];
		const first = new SecretObfuscator(entries, KEY).obfuscate("pw=hunter2-database-pass");
		const second = new SecretObfuscator(entries, KEY).obfuscate("pw=hunter2-database-pass");
		const otherKey = new SecretObfuscator(entries, `${KEY}-other`).obfuscate("pw=hunter2-database-pass");

		expect(first).toMatch(new RegExp(`^pw=\\$\\$DbPass_${WORDS}\\$\\$$`));
		expect(second).toBe(first);
		expect(otherKey).not.toBe(first);
	});

	it("drops a friendly name that spells out its own secret", () => {
		const obfuscator = new SecretObfuscator(
			[{ type: "plain", content: "shown-label-123", friendlyName: "Shown Label 123" }],
			KEY,
		);

		expect(obfuscator.obfuscate("shown-label-123")).toMatch(new RegExp(`^\\$\\$${WORDS}\\$\\$$`));
	});

	it("does not restore tokens in the retired hash format", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "hunter2-database-pass" }], KEY);
		obfuscator.obfuscate("hunter2-database-pass");
		const retired = `$$${"DBPASS_K3J9Q2:L"}$$`;

		expect(obfuscator.deobfuscate(`see ${retired}`)).toBe(`see ${retired}`);
	});
});

describe("session codec", () => {
	it("restores a reloaded session's placeholders in a new process, including regex-discovered values", () => {
		const entries: SecretEntry[] = [
			{ type: "plain", content: "hunter2-database-pass" },
			{ type: "regex", content: "tok_[a-z0-9]{8,}" },
		];
		const userText = "connect with hunter2-database-pass and tok_abcdef123456";
		const writer = new SecretObfuscator(entries, KEY);
		const [sentUser] = obfuscateMessages(writer, [{ role: "user", content: userText, timestamp: 1 }]);
		const modelText = `Using ${(sentUser!.content as string).slice("connect with ".length)}`;
		const stored: AgentMessage[] = [
			{ role: "user", content: userText, timestamp: 1 },
			assistant(modelText, modelText),
		];

		const display = deobfuscateSessionContext(context(stored), new SecretObfuscator(entries, KEY));
		const restored = display.messages[1] as AssistantMessage;

		expect(restored.content).toEqual([
			{
				type: "thinking",
				thinking: "Using hunter2-database-pass and tok_abcdef123456",
				thinkingSignature: "sig-opaque",
			},
			{ type: "text", text: "Using hunter2-database-pass and tok_abcdef123456" },
		]);
		// The stored context the agent replays keeps the model's placeholder form.
		expect((stored[1] as AssistantMessage).content[1]).toEqual({ type: "text", text: modelText });
	});

	it("replays the model's placeholder-form messages byte-identical while encoding outside input", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "hunter2-database-pass" }], KEY);
		const placeholder = obfuscator.obfuscate("hunter2-database-pass");
		const reply = assistant(`stored ${placeholder}`, `thought ${placeholder}`);
		const outbound = obfuscateMessages(obfuscator, [
			reply,
			{ role: "user", content: "now use hunter2-database-pass", timestamp: 3 },
		]);

		expect(outbound[0]).toBe(reply);
		expect(outbound[1]).toEqual({ role: "user", content: `now use ${placeholder}`, timestamp: 3 });
	});
});
