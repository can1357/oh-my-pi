import { describe, expect, it } from "bun:test";
import type {
	BankProfileResponse,
	CreateBankOptions,
	RetainOptions,
	RetainResponse,
} from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import type { HindsightMessage } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const makeConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	scoping: "global",
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: ["world", "experience"],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	debug: false,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 30_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 30_000,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelRefreshIntervalMs: 5 * 60 * 1000,
	mentalModelMaxRenderChars: 16_000,
	...overrides,
});

class FakeHindsightApi extends HindsightApi {
	calls: { bankId: string; transcript: string; options?: RetainOptions }[] = [];

	constructor() {
		super({ baseUrl: "http://localhost" });
	}

	override async createBank(_bankId: string, _options?: CreateBankOptions): Promise<BankProfileResponse> {
		return {};
	}

	override async retain(bankId: string, transcript: string, options?: RetainOptions): Promise<RetainResponse> {
		this.calls.push({ bankId, transcript, options });
		return {};
	}
}

describe("Hindsight incremental full-session retention cache", () => {
	it("Append-only growth: accumulates transcript content incrementally across successive retains", async () => {
		const client = new FakeHindsightApi();
		const config = makeConfig({ retainMode: "full-session" });
		const session = {
			sessionId: "test-session",
		} as object as AgentSession;
		const banksSet = new Set<string>();

		const state = new HindsightSessionState({
			sessionId: "test-session",
			client,
			bankId: "test-bank",
			config,
			session,
			banksSet,
		});

		const messages1: HindsightMessage[] = [
			{ role: "user", content: "hello first turn" },
			{ role: "assistant", content: "hi there first response" },
		];

		await state.retainSession(messages1);
		expect(client.calls.length).toBe(1);
		expect(client.calls[0].transcript).toBe(
			"[role: user]\nhello first turn\n[user:end]\n\n[role: assistant]\nhi there first response\n[assistant:end]",
		);

		client.calls = [];

		const messages2: HindsightMessage[] = [
			...messages1,
			{ role: "user", content: "hello second turn" },
			{ role: "assistant", content: "hi there second response" },
		];

		await state.retainSession(messages2);
		expect(client.calls.length).toBe(1);
		expect(client.calls[0].transcript).toBe(
			"[role: user]\nhello first turn\n[user:end]\n\n[role: assistant]\nhi there first response\n[assistant:end]\n\n" +
				"[role: user]\nhello second turn\n[user:end]\n\n[role: assistant]\nhi there second response\n[assistant:end]",
		);
	});

	it("Branch shrink (rewind): self-heals when message list shrinks, rebuilding and retaining full shorter transcript", async () => {
		const client = new FakeHindsightApi();
		const config = makeConfig({ retainMode: "full-session" });
		const session = {
			sessionId: "test-session",
		} as object as AgentSession;
		const banksSet = new Set<string>();

		const state = new HindsightSessionState({
			sessionId: "test-session",
			client,
			bankId: "test-bank",
			config,
			session,
			banksSet,
		});

		const messages: HindsightMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "assistant", content: "msg2" },
			{ role: "user", content: "msg3" },
			{ role: "assistant", content: "msg4" },
		];

		await state.retainSession(messages);
		expect(client.calls.length).toBe(1);
		expect(client.calls[0].transcript).toContain("msg1");
		expect(client.calls[0].transcript).toContain("msg4");

		client.calls = [];

		// Shrink/rewind back to first 2 messages
		const shorter = messages.slice(0, 2);
		await state.retainSession(shorter);

		expect(client.calls.length).toBe(1);
		expect(client.calls[0].transcript).toBe(
			"[role: user]\nmsg1\n[user:end]\n\n[role: assistant]\nmsg2\n[assistant:end]",
		);

		client.calls = [];

		// Subsequent retain with append works on top of the healed shorter branch
		const appended = [...shorter, { role: "user", content: "msg3_new" }];
		await state.retainSession(appended);

		expect(client.calls.length).toBe(1);
		expect(client.calls[0].transcript).toBe(
			"[role: user]\nmsg1\n[user:end]\n\n[role: assistant]\nmsg2\n[assistant:end]\n\n" +
				"[role: user]\nmsg3_new\n[user:end]",
		);
	});

	it("Branch rewrite at same length: self-heals when tail message is replaced, avoiding stale prefix cache", async () => {
		const client = new FakeHindsightApi();
		const config = makeConfig({ retainMode: "full-session" });
		const session = {
			sessionId: "test-session",
		} as object as AgentSession;
		const banksSet = new Set<string>();

		const state = new HindsightSessionState({
			sessionId: "test-session",
			client,
			bankId: "test-bank",
			config,
			session,
			banksSet,
		});

		const originalBranch: HindsightMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "original tail" },
		];

		await state.retainSession(originalBranch);
		expect(client.calls.length).toBe(1);
		expect(client.calls[0].transcript).toContain("original tail");

		client.calls = [];

		// Rewrite the tail (same length) and add one more message
		const rewrittenBranch: HindsightMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "rewritten tail" },
			{ role: "user", content: "next message" },
		];

		await state.retainSession(rewrittenBranch);
		expect(client.calls.length).toBe(1);

		// The retained transcript should NOT contain the stale "original tail" prefix,
		// and must contain "rewritten tail" and "next message"
		const finalTranscript = client.calls[0].transcript;
		expect(finalTranscript).not.toContain("original tail");
		expect(finalTranscript).toContain("rewritten tail");
		expect(finalTranscript).toContain("next message");
		expect(finalTranscript).toBe(
			"[role: user]\nhello\n[user:end]\n\n[role: assistant]\nrewritten tail\n[assistant:end]\n\n" +
				"[role: user]\nnext message\n[user:end]",
		);
	});

	it("rebuilds when an earlier retained message is rewritten but the boundary message is unchanged", async () => {
		const client = new FakeHindsightApi();
		const config = makeConfig({ retainMode: "full-session" });
		const session = {
			sessionId: "test-session",
		} as object as AgentSession;
		const banksSet = new Set<string>();

		const state = new HindsightSessionState({
			sessionId: "test-session",
			client,
			bankId: "test-bank",
			config,
			session,
			banksSet,
		});

		const messages1: HindsightMessage[] = [
			{ role: "user", content: "A" },
			{ role: "assistant", content: "B" },
			{ role: "user", content: "C" },
		];

		await state.retainSession(messages1);
		expect(client.calls.length).toBe(1);
		expect(client.calls[0].transcript).toBe(
			"[role: user]\nA\n[user:end]\n\n[role: assistant]\nB\n[assistant:end]\n\n[role: user]\nC\n[user:end]",
		);

		client.calls = [];

		// Rewrite only message A, keep B and C identical, append new message D
		const messages2: HindsightMessage[] = [
			{ role: "user", content: "A_rewritten" },
			{ role: "assistant", content: "B" },
			{ role: "user", content: "C" },
			{ role: "assistant", content: "D" },
		];

		await state.retainSession(messages2);
		expect(client.calls.length).toBe(1);

		const finalTranscript = client.calls[0].transcript;
		expect(finalTranscript).not.toContain("A\n");
		expect(finalTranscript).toContain("A_rewritten");
		expect(finalTranscript).toContain("D");
		expect(finalTranscript).toBe(
			"[role: user]\nA_rewritten\n[user:end]\n\n[role: assistant]\nB\n[assistant:end]\n\n" +
				"[role: user]\nC\n[user:end]\n\n[role: assistant]\nD\n[assistant:end]",
		);
	});

	it("forced retain resends the full transcript even when no new messages arrived", async () => {
		const client = new FakeHindsightApi();
		const config = makeConfig({ retainMode: "full-session" });
		const messages: HindsightMessage[] = [
			{ role: "user", content: "hello first turn" },
			{ role: "assistant", content: "hi there first response" },
		];
		const session = {
			sessionId: "test-session",
			sessionManager: {
				getEntries: () => [
					{ type: "message", message: { role: "user", content: "hello first turn" } },
					{
						type: "message",
						message: { role: "assistant", content: [{ type: "text", text: "hi there first response" }] },
					},
				],
			},
		} as object as AgentSession;
		const banksSet = new Set<string>();

		const state = new HindsightSessionState({
			sessionId: "test-session",
			client,
			bankId: "test-bank",
			config,
			session,
			banksSet,
		});

		const expected =
			"[role: user]\nhello first turn\n[user:end]\n\n[role: assistant]\nhi there first response\n[assistant:end]";

		await state.retainSession(messages);
		expect(client.calls.length).toBe(1);
		expect(client.calls[0].transcript).toBe(expected);

		client.calls = [];

		// No new messages since the successful auto-retain: a forced retain must
		// still resend the full transcript (recovery path for lost upstream docs).
		await state.forceRetainCurrentSession();
		expect(client.calls.length).toBe(1);
		expect(client.calls[0].transcript).toBe(expected);
	});

	it("rebuilds when only a retained prefix timestamp changes", async () => {
		const client = new FakeHindsightApi();
		const config = makeConfig({ retainMode: "full-session" });
		const session = {
			sessionId: "test-session",
		} as object as AgentSession;
		const banksSet = new Set<string>();

		const state = new HindsightSessionState({
			sessionId: "test-session",
			client,
			bankId: "test-bank",
			config,
			session,
			banksSet,
		});

		const messages1: HindsightMessage[] = [
			{ role: "user", content: "hello first turn", timestamp: "2026-08-17T10:00:00.000Z" },
			{ role: "assistant", content: "hi there first response", timestamp: "2026-08-17T10:00:05.000Z" },
		];
		await state.retainSession(messages1);
		expect(client.calls[0].transcript).toContain("[timestamp: 2026-08-17T10:00:00.000Z]");

		client.calls = [];
		const messages2: HindsightMessage[] = [
			{ role: "user", content: "hello first turn", timestamp: "2026-08-17T09:00:00.000Z" },
			{ role: "assistant", content: "hi there first response", timestamp: "2026-08-17T10:00:05.000Z" },
			{ role: "user", content: "hello second turn", timestamp: "2026-08-17T11:00:00.000Z" },
		];
		await state.retainSession(messages2);
		expect(client.calls.length).toBe(1);
		expect(client.calls[0].transcript).toContain("[timestamp: 2026-08-17T09:00:00.000Z]");
		expect(client.calls[0].transcript).not.toContain("[timestamp: 2026-08-17T10:00:00.000Z]");
		expect(client.calls[0].transcript).toContain("hello second turn");
	});
});
